import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commitsAnswer } from '../../src/adapter.js'
import { buildComboCatalog, comboChain, COMBO_PREFIX, isComboEntry, normalizeCombos } from '../../src/combos.js'
import { publicModelRows as snapshotModelRows } from '../../src/core/completion.js'
import { recordTurn } from '../../src/store.js'
import { createModelRuntime, createRuntimeStores } from '../../src/core/runtime.js'
import { generateKey, startForwardServer } from '../../src/forward.js'
import { isLoopbackHost } from '../../src/trust.js'
import { createManagement } from './management.mjs'
import { createStandaloneEac } from './eac.mjs'
import { createChannelRuntime } from './channels/runtime.mjs'
import { probeChannelModels } from './channel-probe.mjs'

const PRODUCT = 'our-free-model-standalone'
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export function resolveStandaloneDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.OFM_HOME === 'string' ? env.OFM_HOME.trim() : ''
  return configured === '' ? path.join(home, '.our-free-model') : path.resolve(configured)
}

/** 直接创建核心和 HTTP 服务，不加载插件入口、Cordis 或 DSH 凭据。 */
export async function startStandalone({
  dataDir = resolveStandaloneDataDir(), host = '127.0.0.1', port,
  logger = console, refresh = true, probe,
} = {}) {
  if (!isLoopbackHost(host)) throw new TypeError('the standalone service binds a loopback address only')
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new TypeError('port must be an integer between 0 and 65535')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const lockFile = path.join(dataDir, 'service.lock')
  const lock = fs.openSync(lockFile, 'wx', 0o600)
  let stores
  let runtime
  let listener
  let management
  let channels
  let eac
  let timer
  let refreshInFlight
  let closing
  let stopped = false
  const lifetime = new AbortController()
  const releaseLock = () => {
    fs.closeSync(lock)
    fs.unlinkSync(lockFile)
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, product: PRODUCT }))
    stores = createRuntimeStores({ dataDir, logger })
    const { settings } = stores
    const savedPort = settings.get().standalonePort
    const requestedPort = port ?? (Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : 18900)
    const existingKey = settings.get().forwardKey
    const key = typeof existingKey === 'string' && existingKey !== '' ? existingKey : generateKey()
    settings.update({ forwardKey: key, ...probe === undefined ? {} : { standaloneProbe: probe === true } })
    settings.flush()
    if (settings.writeFailed) throw new Error('could not persist the standalone API key')
    eac = createStandaloneEac({
      dataDir,
      onSaved: () => { void runtime?.refreshSealedLane().catch(error => logger.warn?.(`EAC 清单刷新失败：${error.message}`)) },
    })
    runtime = createModelRuntime({
      ...stores, logger, attributionUserAgent: `${PRODUCT}/${VERSION}`,
      sealedCredential: eac.credential,
    })
    channels = await createChannelRuntime({ dataDir, logger, stats: stores.stats })
    const core = runtime
    // 渠道行与组合行在 service 层组装：核心目录只认识免费/Kilo/EAC/聚合车道，
    // 而模型组（combo）的成员可以来自账号渠道——那类成员只有渠道 Worker 能推理。
    // 每次读取都按当前 settings 和渠道清单现算，因此管理页改动立即生效。
    const channelRows = () => channels.publicModelRows().map(row => ({
      ...row, contextWindow: row.context_window, maxOutput: row.max_tokens,
    }))
    const realRows = () => [...core.catalog.filter(entry => !isComboEntry(entry)), ...channelRows()]
    const comboRows = () => buildComboCatalog(normalizeCombos(settings.get().combos), realRows())
    const completeCombo = async (entry, request, onChunk) => {
      // 与核心 runCombo 同一条提交规则：在第一个可见正文块之前，整条候选可以被
      // 无声丢弃并换下一个；一旦开始产出，后续失败走正常错误路径，绝不拼接。
      const candidates = comboChain(entry, realRows())
      let last
      for (const [index, candidate] of candidates.entries()) {
        if (request.signal?.aborted) break
        let committed = false
        const held = []
        const sink = chunk => {
          if (committed) { onChunk?.(chunk); return }
          held.push(chunk)
          if (commitsAnswer(chunk)) {
            committed = true
            for (const item of held) onChunk?.(item)
            held.length = 0
          }
        }
        try {
          last = channels.handles(candidate.id)
            ? await channels.complete({ ...request, model: candidate.id }, onChunk === undefined ? undefined : sink)
            : await core.complete({ ...request, model: candidate.id }, onChunk === undefined ? undefined : sink)
        } catch (error) {
          last = { text: '', toolCalls: [], error: error?.message ?? String(error) }
        }
        if (committed) {
          try {
            recordTurn(stores.stats, { at: Date.now(), model: entry.id, ok: last?.error === undefined, recovered: index > 0, origin: 'forward' })
          } catch { /* 统计失败不影响推理 */ }
          return last
        }
      }
      return last ?? { text: '', toolCalls: [], error: `the chain "${entry.name}" has no model available on this egress` }
    }
    runtime = {
      ...core,
      get egress() { return core.egress },
      get gatewayLatency() { return core.gatewayLatency },
      get catalog() { return [...realRows(), ...comboRows()] },
      state: () => ({ ...core.state(), catalog: [...realRows(), ...comboRows()] }),
      publicModelRows: () => [
        ...snapshotModelRows(core.state()).filter(row => !row.id.startsWith(COMBO_PREFIX)),
        ...channels.publicModelRows(),
        ...comboRows().map(entry => ({
          id: entry.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'our-free-model',
          context_window: entry.contextWindow,
        })),
      ],
      complete: (request, onChunk) => {
        if (channels.handles(request.model)) return channels.complete(request, onChunk)
        if (request.model.startsWith(COMBO_PREFIX)) {
          const entry = comboRows().find(row => row.id === request.model)
          // 组合行按 settings 现算：找不到意味着这条链刚被删光或成员全部失效，
          // 此时不能回落到核心里可能残留的旧行，直接如实 404。
          if (entry === undefined) {
            return Promise.reject(Object.assign(new Error(`model "${request.model}" not found`), { statusCode: 404 }))
          }
          return completeCombo(entry, request, onChunk)
        }
        return core.complete(request, onChunk)
      },
      async refreshCatalog(options) {
        if (stopped) return
        await Promise.all([core.refreshCatalog(options), channels.refresh().catch(error => { if (!stopped) throw error })])
        // 渠道模型行不走核心探测（那是对免费网关发的）；核心探测开着的轮次
        // （手动“探测可用性”或开启自动探测后的周期轮）顺带覆盖账号渠道，
        // 判定写进同一个 availability 存储，管理页据此显示真实状态。
        if (options?.probe === true && !stopped) {
          const rows = channels.publicModelRows()
          await probeChannelModels(channels, rows, { signal: lifetime.signal }, (id, result) => {
            if (stopped) return
            stores.availability.edit(value => ({
              ...value,
              results: {
                ...value.results,
                [id]: {
                  state: result.state,
                  ...result.detail === undefined ? {} : { detail: result.detail },
                  ...result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs },
                  latencyMs: result.latencyMs, at: Date.now(),
                },
              },
            }))
          })
          if (stopped) return
          stores.availability.update({ at: Date.now(), egress: core.egress })
          stores.availability.flush()
        }
      },
    }
    management = createManagement({
      stores, runtime, channels, eac,
      info: () => ({
        product: PRODUCT, version: VERSION, dataDir,
        baseUrl: `http://${host === '::1' ? '[::1]' : host}:${listener?.port ?? requestedPort}`,
        automaticRefresh: refresh,
        networkMode: process.env.OFM_TEST_UPSTREAM ? 'fixture' : 'live',
        capabilities: { anonymous: true, kilo: true, eac: true, accountChannels: true, webUi: true },
      }),
      onSettingsChanged: () => { if (!refreshInFlight) scheduleRefresh() },
    })
    listener = await startForwardServer({
      config: () => ({ host, port: requestedPort, enabled: settings.get().enabled !== false, key: settings.get().forwardKey }),
      complete: runtime.complete,
      modelRows: runtime.publicModelRows,
      health: () => ({
        ok: true, service: PRODUCT, product: 'standalone', version: VERSION,
        capabilities: { anonymous: true, kilo: true, eac: true, accountChannels: true, webUi: true },
      }),
      handleRequest: management.handleRequest,
      log: message => logger.warn?.(`our-free-model standalone: ${message}`),
    })
    management.setPort(listener.port)
    settings.update({ standalonePort: listener.port })
    settings.flush()

    function scheduleRefresh() {
      clearTimeout(timer)
      if (stopped || !refresh) return
      const minutes = Number(settings.get().probeIntervalMinutes)
      timer = setTimeout(() => { void refreshModels() }, (Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 15) * 60_000)
      timer.unref?.()
    }
    function refreshModels(force = false) {
      if (refreshInFlight) return refreshInFlight
      refreshInFlight = runtime.refreshCatalog({ probe: settings.get().standaloneProbe === true, force })
        .catch(error => {
          if (!stopped) logger.warn?.(`our-free-model standalone: catalog refresh failed (${error?.message ?? error})`)
        })
        .finally(() => { refreshInFlight = undefined; scheduleRefresh() })
      return refreshInFlight
    }
    // 启动可强制探测；后续周期刷新遵守核心的限流退避。
    const ready = Promise.all([channels.ready, refresh ? refreshModels(settings.get().standaloneProbe === true) : Promise.resolve()])
    return {
      product: PRODUCT, version: VERSION, dataDir,
      url: `http://${host === '::1' ? '[::1]' : host}:${listener.port}`,
      managementUrl: `http://${host === '::1' ? '[::1]' : host}:${listener.port}/${management.bootstrapFragment}`,
      port: listener.port,
      keyFile: path.join(dataDir, 'settings.json'),
      runtime, channels, ready,
      close() {
        if (closing !== undefined) return closing
        stopped = true
        clearTimeout(timer)
        lifetime.abort()
        management.dispose()
        eac.dispose()
        runtime.dispose()
        closing = (async () => {
          try { await Promise.all([listener.close(), channels.close()]) } finally {
            stores.dispose()
            releaseLock()
          }
        })()
        return closing
      },
    }
  } catch (error) {
    stopped = true
    clearTimeout(timer)
    management?.dispose()
    eac?.dispose()
    runtime?.dispose()
    if (listener) await listener.close()
    await channels?.close()
    stores?.dispose()
    releaseLock()
    throw error
  }
}
