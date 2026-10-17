import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
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

/** 内核自动释放的互斥端点，串行化同一数据目录的锁检查与回收。 */
async function acquireProcessGuard(dataDir) {
  // 其他平台保留原来的保守文件锁行为，不使用会遗留文件的 Unix Socket。
  if (process.platform !== 'win32' && process.platform !== 'linux') return null
  let canonical = fs.realpathSync.native(dataDir)
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  const id = crypto.createHash('sha256').update(canonical).digest('hex')
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\ofm-service-lock-${id}` : `\0ofm-service-lock-${id}`
  const server = net.createServer(socket => socket.destroy())
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, resolve)
    })
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw Object.assign(new Error('数据目录已被服务占用'), { code: 'EEXIST', cause: error })
    }
    throw error
  }
  server.unref()
  return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function acquireServiceLock(dataDir) {
  const releaseGuard = await acquireProcessGuard(dataDir)
  const lockFile = path.join(dataDir, 'service.lock')
  const token = crypto.randomUUID()
  let lock
  let ownedStat
  const removeOwnedLock = () => {
    try {
      const current = fs.lstatSync(lockFile)
      if (current.isFile() && current.dev === ownedStat.dev && current.ino === ownedStat.ino) {
        fs.unlinkSync(lockFile)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try {
    try { lock = fs.openSync(lockFile, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST' || !releaseGuard) throw error
      const previousStat = fs.lstatSync(lockFile)
      if (!previousStat.isFile()) throw error
      const previous = fs.readFileSync(lockFile, 'utf8')
      let owner
      try { owner = JSON.parse(previous) } catch { throw error }
      if (owner?.product !== PRODUCT || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw error
      // 只有 ESRCH 能证明进程已经退出；无权限、PID 复用等情况均保留原锁。
      let exited = false
      try { process.kill(owner.pid, 0) }
      catch (probeError) { exited = probeError.code === 'ESRCH' }
      if (!exited) throw error
      const current = fs.lstatSync(lockFile)
      if (current.dev !== previousStat.dev || current.ino !== previousStat.ino ||
          fs.readFileSync(lockFile, 'utf8') !== previous) throw error
      fs.unlinkSync(lockFile)
      lock = fs.openSync(lockFile, 'wx', 0o600)
    }
    ownedStat = fs.fstatSync(lock)
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, product: PRODUCT, token }))
  } catch (error) {
    try {
      if (lock !== undefined) {
        fs.closeSync(lock)
        if (ownedStat) removeOwnedLock()
      }
    } finally { await releaseGuard?.() }
    throw error
  }
  return async () => {
    try {
      // 在关闭文件句柄前核对归属，避免异常替换的锁被本实例清理。
      const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (current?.token === token && current.pid === process.pid && current.product === PRODUCT) removeOwnedLock()
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    } finally {
      try { fs.closeSync(lock) } finally { await releaseGuard?.() }
    }
  }
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
  const releaseLock = await acquireServiceLock(dataDir)
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
  // 渠道探测的长生命周期取消器：与上游的 acquireServiceLock 无关，锁释放已由
  // releaseLock（上方 await acquireServiceLock 的返回值）统一负责。
  const lifetime = new AbortController()
  try {
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
      ...process.env.OFM_TEST_UPSTREAM ? { openExternal: async () => false } : {},
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
    // 用户主动关闭的模型（settings.disabledModels，行 ID 集合）：从公开清单、
    // 推理路由、组合链成员与探测中统一剔除，但保留在目录里供「已关闭」页展示。
    const disabledSet = () => new Set(Array.isArray(settings.get().disabledModels) ? settings.get().disabledModels : [])
    const visibleRows = () => { const disabled = disabledSet(); return realRows().filter(row => !disabled.has(row.id)) }
    const comboRows = () => buildComboCatalog(normalizeCombos(settings.get().combos), visibleRows())
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
      publicModelRows: () => {
        const disabled = disabledSet()
        return [
          ...snapshotModelRows(core.state()).filter(row => !row.id.startsWith(COMBO_PREFIX) && !disabled.has(row.id)),
          ...channels.publicModelRows().filter(row => !disabled.has(row.id)),
          ...comboRows().map(entry => ({
            id: entry.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'our-free-model',
            context_window: entry.contextWindow,
          })),
        ]
      },
      complete: (request, onChunk) => {
        // 已关闭的模型对推理一律 404：客户端看到的目录里根本没有它。
        if (disabledSet().has(request.model)) {
          return Promise.reject(Object.assign(new Error(`model "${request.model}" is disabled`), { statusCode: 404 }))
        }
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
          // 已关闭的模型不再探测，避免白白消耗账号额度。
          const disabled = disabledSet()
          const rows = channels.publicModelRows().filter(row => !disabled.has(row.id))
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
      log: message => logger.warn?.(`our-free-model standalone: ${message}`),
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
            try { stores.dispose() } finally { await releaseLock() }
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
    try { stores?.dispose() } finally { await releaseLock() }
    throw error
  }
}
