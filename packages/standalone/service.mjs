import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { commitsAnswer } from '../../src/adapter.js'
import { aliasModelRow, buildAliasRows, normalizeAliasSettings, resolveModelAlias } from '../../src/aliases.js'
import { buildComboCatalog, comboChain, COMBO_PREFIX, isComboEntry, normalizeCombos } from '../../src/combos.js'
import { publicModelRows as snapshotModelRows } from '../../src/core/completion.js'
import { recordTurn } from '../../src/store.js'
import { recordAttempt } from '../../src/core/attempts.js'
import { createModelRuntime, createRuntimeStores } from '../../src/core/runtime.js'
import { generateKey, rankLanAddresses, startForwardServer, startLanRelay } from '../../src/forward.js'
import { isLoopbackHost } from '../../src/trust.js'
import { createManagement } from './management.mjs'
import { createStandaloneEac } from './eac.mjs'
import { createChannelRuntime } from './channels/runtime.mjs'
import { classifyChannelFailure, probeChannelModels, testChannelModel } from './channel-probe.mjs'
import { MODEL_TEST_TIMEOUT_MS } from '../../src/model-test.js'

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
      // 无 releaseGuard 的平台（darwin：acquireProcessGuard 返回 null）同样允许回收陈旧锁。
      // guard 只提供串行化优化，防误删依靠下面的 dev/ino 比对与内容二次核对。
      if (error.code !== 'EEXIST') throw error
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
  logger = console, refresh = true, probe, lanEnabled, lanPort,
  startRelay = startLanRelay,
} = {}) {
  if (!isLoopbackHost(host)) throw new TypeError('the standalone service binds a loopback address only')
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new TypeError('port must be an integer between 0 and 65535')
  }
  if (lanEnabled !== undefined && typeof lanEnabled !== 'boolean') throw new TypeError('lanEnabled must be a boolean')
  if (lanPort !== undefined && (!Number.isInteger(lanPort) || lanPort < 0 || lanPort > 65535)) {
    throw new TypeError('lanPort must be an integer between 0 and 65535')
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
  // 「探测可用性」的实时进度：管理页在探测期间短轮询 GET /models/probe 显示进度条。
  // phase 走 catalog（核心免费车道，行数未知）→ channels（渠道行，知道总数）→ done。
  let probeProgress = { running: false, phase: 'idle', done: 0, total: 0, startedAt: 0, finishedAt: 0 }
  // 渠道探测的长生命周期取消器：与上游的 acquireServiceLock 无关，锁释放已由
  // releaseLock（上方 await acquireServiceLock 的返回值）统一负责。
  const lifetime = new AbortController()
  let relay
  let relayTarget
  let relayRequestedPort
  let relayError = null
  let relayChanges = Promise.resolve()
  const lanState = () => {
    const value = stores.settings.get()
    const addresses = rankLanAddresses(os.networkInterfaces())
    return {
      enabled: value.standaloneLanEnabled === true,
      running: relay !== undefined,
      host: relay?.host ?? '0.0.0.0',
      requestedPort: value.standaloneLanPort ?? 0,
      port: relay?.port ?? null,
      addresses,
      baseUrls: relay ? addresses.map(address => `http://${address}:${relay.port}/v1`) : [],
      error: relayError,
    }
  }
  async function closeRelay() {
    const current = relay
    const target = relayTarget
    relay = undefined
    relayTarget = undefined
    relayRequestedPort = undefined
    await Promise.all([current?.close(), target?.close()])
  }
  function reconcileRelay() {
    relayChanges = relayChanges.then(async () => {
      const value = stores.settings.get()
      const wantedPort = value.standaloneLanPort ?? 0
      relayError = null
      if (stopped || value.enabled === false || value.standaloneLanEnabled !== true) {
        await closeRelay()
        return
      }
      if (relay && relayRequestedPort === wantedPort) return
      await closeRelay()
      try {
        if (typeof value.standaloneLanKey !== 'string' || value.standaloneLanKey === '' ||
            value.standaloneLanKey === value.forwardKey) {
          settingsPersist({ standaloneLanKey: generateKey() })
        }
        // The shared relay targets IPv4 loopback. An IPv6 management bind needs
        // a separate inference-only loopback target, with no management handler.
        if (listener.server.address().address !== '127.0.0.1') {
          relayTarget = await startForwardServer({
            config: () => ({
              host: '127.0.0.1', port: 0,
              enabled: !stopped && stores.settings.get().enabled !== false,
              key: stores.settings.get().forwardKey,
            }),
            complete: runtime.complete, modelRows: runtime.publicModelRows,
          })
        }
        const targetPort = relayTarget?.port ?? listener.port
        const started = await startRelay({
          config: () => ({
            enabled: !stopped && stores.settings.get().enabled !== false && stores.settings.get().standaloneLanEnabled === true,
            host: '0.0.0.0', port: wantedPort, targetPort,
            lanKey: stores.settings.get().standaloneLanKey,
            localKey: stores.settings.get().forwardKey,
          }),
          log: message => logger.warn?.(`our-free-model standalone LAN: ${message}`),
        })
        relay = started
        relayRequestedPort = wantedPort
        if (stopped || stores.settings.get().enabled === false || stores.settings.get().standaloneLanEnabled !== true) await closeRelay()
      } catch (error) {
        await closeRelay()
        relayError = `LAN relay could not start (${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'START_FAILED'})`
        logger.warn?.(relayError)
      }
    })
    return relayChanges
  }
  function settingsPersist(patch) {
    const previous = stores.settings.get()
    stores.settings.update(patch)
    stores.settings.flush()
    if (stores.settings.writeFailed) {
      stores.settings.value = previous
      throw new Error('could not persist the standalone LAN settings')
    }
  }
  try {
    stores = createRuntimeStores({ dataDir, logger })
    const { settings } = stores
    const savedPort = settings.get().standalonePort
    const requestedPort = port ?? (Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : 18900)
    const existingKey = settings.get().forwardKey
    const key = typeof existingKey === 'string' && existingKey !== '' ? existingKey : generateKey()
    const savedLanPort = settings.get().standaloneLanPort
    settings.update({
      forwardKey: key,
      standaloneLanEnabled: lanEnabled ?? settings.get().standaloneLanEnabled === true,
      standaloneLanPort: lanPort ?? (Number.isInteger(savedLanPort) && savedLanPort >= 0 && savedLanPort <= 65535 ? savedLanPort : 0),
      ...probe === undefined ? {} : { standaloneProbe: probe === true },
    })
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
    // 别名层：可读名 → 真实 id。按当前目录现算、只落在 settings 的改名/关闭覆盖上，
    // 因此渠道刷新掉某个模型时它的别名一并消失，不会留下指向空处的旧名字。
    // 分配必须基于**含禁用行**的全量目录：若按可见目录算，禁用 A 渠道的同名模型
    // 会让 B 渠道的模型接管纯名，正在用这个名字的客户端就被静默换到了另一个模型。
    const aliasSettings = () => normalizeAliasSettings(settings.get().aliases)
    const aliasRows = () => buildAliasRows(realRows(), aliasSettings())
    const completeCombo = async (entry, request, onChunk) => {
      // 与核心 runCombo 同一条提交规则：在第一个可见正文块之前，整条候选可以被
      // 无声丢弃并换下一个；一旦开始产出，后续失败走正常错误路径，绝不拼接。
      const started = Date.now()
      // 降级尝试环：只记「试过谁、为什么换掉、花了多久」。core 侧的 runCombo 有同名
      // 的一笔（src/adapter.js），两条推理路径共写同一个 stats store。注意不记速度——
      // tps/ttft 只存在于单模型的解码窗口内，这里拿不到，编造出来的数字比没有更糟。
      const note = (candidate, index, outcome, reason) => {
        try {
          recordAttempt(stores.stats, {
            // turnAt = 本回合起点，同一回合每一行都相同（前端靠它分组）。
            turnAt: started,
            at: Date.now(), chainId: entry.id, chainName: entry.name, index,
            candidateId: candidate.id, outcome, reason, elapsedMs: Date.now() - started,
          }, message => logger.warn?.(message))
        } catch { /* 记录失败不影响推理 */ }
      }
      /**
       * 失败回合也要进 /stats：此前 forward 路径只在命中时记回合，链全灭/被中止的
       * 回合只进走查环、不进周期数字——「降级接管」KPI 与候选链对不上，正是从
       * 这里漏的。attempts 与 core 侧 rejectedTurn 同口径（走到第几个候选，1 起）。
       */
      const rejectTurn = attempts => {
        try {
          recordTurn(stores.stats, { at: started, model: entry.id, ok: false, recovered: false, attempts, origin: 'forward' })
        } catch { /* 统计失败不影响推理 */ }
      }
      const candidates = comboChain(entry, realRows())
      if (candidates.length === 0) {
        rejectTurn(0)
        return { text: '', toolCalls: [], error: `the chain "${entry.name}" has no model available on this egress` }
      }
      let last
      for (const [index, candidate] of candidates.entries()) {
        if (request.signal?.aborted) {
          note(candidate, index, 'aborted', 'aborted')
          rejectTurn(index)
          return last ?? { text: '', toolCalls: [], error: 'aborted' }
        }
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
          // __ofmComboMember：成员是组合内部的物理尝试，不各自记「用户回合」。
          // 回合由本函数按 outcome 统一记一笔（命中记 ok、全灭记 rejectTurn）；
          // token/用量仍走成员自己的 complete 如实记。
          last = channels.handles(candidate.id)
            ? await channels.complete({ ...request, model: candidate.id, __ofmComboMember: true }, onChunk === undefined ? undefined : sink)
            : await core.complete({ ...request, model: candidate.id, __ofmComboMember: true }, onChunk === undefined ? undefined : sink)
        } catch (error) {
          last = { text: '', toolCalls: [], error: error?.message ?? String(error) }
        }
        if (committed) {
          note(candidate, index, 'hit', '')
          try {
            recordTurn(stores.stats, { at: Date.now(), model: entry.id, ok: last?.error === undefined, recovered: index > 0, attempts: index + 1, origin: 'forward' })
          } catch { /* 统计失败不影响推理 */ }
          return last
        }
        // 非流式：整包返回，没有逐块提交可判。与 commitsAnswer 等价的整包规则
        // 是「无 error 且带非空正文或工具调用」——调用方真的拿到了答案。
        //
        // 首版在这里没有早停：没有 onChunk 就没有 sink，`committed` 永远不置位，
        // 循环会把每个成员都跑一遍并返回最后一个的结果——前位候选明明答了、
        // 后位候选却失败时，调用方拿到的居然是失败。本次修掉：答了即停，
        // 与流式/核心 runCombo 的提交语义对齐。
        if (onChunk === undefined) {
          const answered = last?.error === undefined
            && (String(last?.text ?? '').trim() !== '' || (Array.isArray(last?.toolCalls) && last.toolCalls.length > 0))
          if (answered) {
            note(candidate, index, 'hit', '')
            try {
              recordTurn(stores.stats, { at: started, model: entry.id, ok: true, recovered: index > 0, attempts: index + 1, origin: 'forward' })
            } catch { /* 统计失败不影响推理 */ }
            return last
          }
        }
        // 流式未提交，或非流式没有给出答案：这个候选被整条丢弃，换下一个。
        note(candidate, index, 'skipped', last?.error ?? 'failed')
      }
      rejectTurn(candidates.length)
      return last ?? { text: '', toolCalls: [], error: `the chain "${entry.name}" exhausted every candidate` }
    }
    // 组合（combo）模型的手工实测。
    //
    // 组合行是 service 层用 comboRows() 现算的虚拟行，既不被 channels.handles 认领
    // （渠道 Worker 只认 provider/model），也不在 core.testModel 的 core.catalog 里
    // （核心目录只认识免费/Kilo/EAC/聚合车道）。此前 combo 点「测试」两头落空，
    // 一律掉进 core.testModel 抛 `Unknown model`——页面能列出来、能推理（complete
    // 有 comboRows 分流），偏偏测不了。这里补上同一道分流：走 completeCombo 真实
    // 发一次探测请求（链首可用候选起步、按顺序降级），把整条链当成一个可测单元。
    //
    // 判定与持久化仍走上游那一套：成功/失败都写 manualResults（与自动探测分开
    // 存，迟到的旧探测不能覆盖新实测），并用 token 挡住更早那次测试的迟到写入。
    const latestComboTests = new Map()
    const testComboRow = async (entry, id, effort, options = {}) => {
      const { signal } = options
      const token = {}
      latestComboTests.set(id, token)
      const persist = row => {
        if (stopped || signal?.aborted || latestComboTests.get(id) !== token) return false
        stores.availability.edit(value => ({ ...value, manualResults: { ...value.manualResults, [id]: row } }))
        stores.availability.flush()
        return !stores.availability.writeFailed
      }
      const started = Date.now()
      try {
        // 与 testChannelModel 同一套探测口径：system 前置 + 最小 user 消息，满足
        // 腾讯系网关「首条必须是 system」的约束；completeCombo 沿链降级直到有人
        // 真正回话，整条链的可用性由最终是否有正文判定。
        const outcome = await completeCombo(entry, {
          model: id, signal,
          openAi: {
            messages: [
              { role: 'system', content: 'You are a connectivity test endpoint. Reply briefly with the requested word.' },
              { role: 'user', content: 'Reply with exactly: OK' },
            ],
            max_tokens: 32,
          },
        })
        const failure = outcome?.error
        if (failure !== undefined && failure !== null && String(failure).trim() !== '') {
          throw Object.assign(new Error(String(failure)), { channelVerdict: true })
        }
        const text = typeof outcome?.text === 'string' ? outcome.text : ''
        if (text.trim() === '') throw Object.assign(new Error('实测没有返回任何正文'), { channelVerdict: true })
        const elapsed = Date.now() - started
        const persisted = persist({
          state: 'available', source: 'manual', at: Date.now(),
          latencyMs: elapsed, ttftMs: elapsed,
        })
        return { model: id, effort, ok: true, latencyMs: elapsed, ttftMs: elapsed, text: text.slice(0, 2000), sample: text.slice(0, 60), persisted }
      } catch (error) {
        if (!signal?.aborted) {
          const verdict = classifyChannelFailure(error, started)
          persist({
            state: verdict.state, source: 'manual', at: Date.now(),
            detail: verdict.detail, latencyMs: verdict.latencyMs,
          })
        }
        throw error
      } finally {
        if (latestComboTests.get(id) === token) latestComboTests.delete(id)
      }
    }
    // 渠道模型的手工实测。
    //
    // 核心 testModel 只在 `core.catalog` 里 find，而账号渠道行是 service 层拼进
    // 目录的（见 realRows 的注释：核心目录只认识免费/Kilo/EAC/聚合车道）。直接把
    // id 转给 core.testModel，渠道模型一律得到 `Unknown model` —— 页面能列出来、
    // 能推理（complete 有 handles 分流），偏偏测不了。这里补上同一道分流。
    //
    // 判定与持久化仍走上游那一套：成功/失败都写 manualResults（与自动探测分开
    // 存，迟到的旧探测不能覆盖新实测），并用 token 挡住更早那次测试的迟到写入。
    const latestChannelTests = new Map()
    const testChannelRow = async (id, effort, options = {}) => {
      if (id.startsWith(COMBO_PREFIX)) {
        const entry = comboRows().find(row => row.id === id)
        // 找不到组合行：这条链刚被删光或成员全部失效，交给 core 如实报 404。
        if (entry === undefined) return core.testModel(id, effort, options)
        return testComboRow(entry, id, effort, options)
      }
      if (!channels.handles(id)) return core.testModel(id, effort, options)
      const { signal } = options
      const token = {}
      latestChannelTests.set(id, token)
      const persist = row => {
        if (stopped || signal?.aborted || latestChannelTests.get(id) !== token) return false
        stores.availability.edit(value => ({ ...value, manualResults: { ...value.manualResults, [id]: row } }))
        stores.availability.flush()
        return !stores.availability.writeFailed
      }
      const started = Date.now()
      try {
        const measured = await testChannelModel(channels, id, { signal, timeoutMs: MODEL_TEST_TIMEOUT_MS })
        const persisted = persist({
          state: 'available', source: 'manual', at: Date.now(),
          ttftMs: measured.ttftMs, latencyMs: measured.latencyMs,
        })
        return { model: id, effort, ok: true, ...measured, persisted }
      } catch (error) {
        // 取消是用户动作，不是对模型的裁决：不写存储，也不把已有的「可用」降级。
        // 其余失败按渠道归类写回（限流 / 需重新登录 / 明确不支持），页面才看得出
        // 该等解禁、该去重新登录，还是这个模型真的没有。
        if (!signal?.aborted) {
          const verdict = classifyChannelFailure(error, started)
          persist({
            state: verdict.state, source: 'manual', at: Date.now(),
            detail: verdict.detail, latencyMs: verdict.latencyMs,
          })
        }
        throw error
      } finally {
        if (latestChannelTests.get(id) === token) latestChannelTests.delete(id)
      }
    }
    runtime = {
      ...core,
      testModel: testChannelRow,
      get egress() { return core.egress },
      get gatewayLatency() { return core.gatewayLatency },
      get catalog() { return [...realRows(), ...comboRows()] },
      state: () => ({ ...core.state(), catalog: [...realRows(), ...comboRows()] }),
      aliasRows: () => aliasRows(),
      aliasSettings,
      publicModelRows: () => {
        const disabled = disabledSet()
        const real = [
          ...snapshotModelRows(core.state()).filter(row => !row.id.startsWith(COMBO_PREFIX) && !disabled.has(row.id)),
          ...channels.publicModelRows().filter(row => !disabled.has(row.id)),
          ...comboRows().map(entry => ({
            id: entry.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'our-free-model',
            // 组合是用户起的虚拟模型：给个 name 才能被按显示名建索引的客户端列出来，
            // 后缀「· 组合」让它在清单里和同名真模型区分开，不会被去重吞掉。
            name: `${entry.name ?? entry.id} · 组合`,
            context_window: entry.contextWindow,
          })),
        ]
        const mode = aliasSettings().mode
        // `id` 是历史行为；`both` 额外广播别名；`alias` 只广播别名。
        // 三种模式下原始 id 都能路由，切换模式不会让已配好的客户端突然 404。
        if (mode === 'id') return real
        const byId = new Map(real.map(row => [row.id, row]))
        const aliased = []
        const replaced = new Set()
        for (const row of aliasRows()) {
          const target = byId.get(row.target)
          if (target === undefined) continue
          // 能力/上下文/计费字段全部继承真实行：别名只是换了个名字，不是另一种模型。
          // `name` 由 aliasModelRow 换成别名本身——客户端按显示名去重，继承原名会被
          // 当成重复项静默丢掉，外部客户端的「添加模型」弹窗里就只剩原始 id。
          aliased.push(aliasModelRow(target, row.alias))
          replaced.add(row.target)
        }
        // `alias` 模式下只藏「已经有别名」的行：组合、以及 id 本来就认得出的模型
        // 没有别名可用，必须原样留着，否则它们会在清单里凭空消失。
        if (mode === 'alias') return [...real.filter(row => !replaced.has(row.id)), ...aliased]
        return [...real, ...aliased]
      },
      complete: (request, onChunk) => {
        // 别名必须在任何分发判断之前展开：渠道按 `provider/` 前缀认路，
        // 禁用表存的也是真实 id，晚一步展开就会既认不出渠道、也漏掉禁用。
        const model = resolveModelAlias(request.model, aliasRows())
        const routed = model === request.model ? request : { ...request, model }
        // 已关闭的模型对推理一律 404：客户端看到的目录里根本没有它。
        // 报错回显调用方写的名字（可能是别名）：读这句话的人要对上的是自己在
        // 客户端里填的那一行，而不是内部展开后的 id。
        if (disabledSet().has(model)) {
          return Promise.reject(Object.assign(new Error(`model "${request.model}" is disabled`), { statusCode: 404 }))
        }
        if (channels.handles(model)) return channels.complete(routed, onChunk)
        if (model.startsWith(COMBO_PREFIX)) {
          const entry = comboRows().find(row => row.id === model)
          // 组合行按 settings 现算：找不到意味着这条链刚被删光或成员全部失效，
          // 此时不能回落到核心里可能残留的旧行，直接如实 404。
          if (entry === undefined) {
            return Promise.reject(Object.assign(new Error(`model "${request.model}" not found`), { statusCode: 404 }))
          }
          return completeCombo(entry, routed, onChunk)
        }
        return core.complete(routed, onChunk)
      },
      async refreshCatalog(options) {
        if (stopped) return
        const probing = options?.probe === true
        if (probing) {
          probeProgress = { running: true, phase: 'catalog', done: 0, total: 0, startedAt: Date.now(), finishedAt: 0 }
        }
        try {
          await Promise.all([core.refreshCatalog(options), channels.refresh().catch(error => { if (!stopped) throw error })])
          // 渠道模型行不走核心探测（那是对免费网关发的）；核心探测开着的轮次
          // （手动“探测可用性”或开启自动探测后的周期轮）顺带覆盖账号渠道，
          // 判定写进同一个 availability 存储，管理页据此显示真实状态。
          if (probing && !stopped) {
            // 已关闭的模型不再探测，避免白白消耗账号额度。
            const disabled = disabledSet()
            const rows = channels.publicModelRows().filter(row => !disabled.has(row.id))
            // 核心段跑完才知道渠道行一共多少条，进度条从这一段开始有分母。
            probeProgress = { ...probeProgress, phase: 'channels', done: 0, total: rows.length }
            // 渠道段按渠道分组并发（同渠道 2 条、跨渠道最多 8 条）、单条 20 秒截止：
            // 实测一轮 33 行里 32 条健康行各 1–3 s，旧的全局并发 2 + 45 s 超时会被
            // 一条死模型独占半个通道，整轮 58 s。分组并发既快又不把同一账号打出 429。
            // 免费车道那一段（core.refreshCatalog）不动：它的额度按会话算，并发必须低。
            await probeChannelModels(channels, rows, {
              signal: lifetime.signal, perChannel: 2, concurrency: 8, timeoutMs: 20_000,
            }, (id, result) => {
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
              probeProgress = { ...probeProgress, done: probeProgress.done + 1 }
            })
            if (stopped) return
            stores.availability.update({ at: Date.now(), egress: core.egress })
            stores.availability.flush()
          }
        } finally {
          // 中途被打断（服务关闭、上游报错）也要收尾，否则管理页会一直显示进度条。
          if (probing) probeProgress = { ...probeProgress, running: false, phase: 'done', finishedAt: Date.now() }
        }
      },
      probeProgress: () => ({ ...probeProgress }),
    }
    management = createManagement({
      stores, runtime, channels, eac,
      info: () => ({
        product: PRODUCT, version: VERSION, dataDir,
        baseUrl: `http://${host === '::1' ? '[::1]' : host}:${listener?.port ?? requestedPort}`,
        automaticRefresh: refresh,
        networkMode: process.env.OFM_TEST_UPSTREAM ? 'fixture' : 'live',
        capabilities: { anonymous: true, kilo: true, eac: true, accountChannels: true, webUi: true, lan: true },
        lan: lanState(),
      }),
      onSettingsChanged: async () => {
        if (!refreshInFlight) scheduleRefresh()
        await reconcileRelay()
      },
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
    await reconcileRelay()

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
      get lan() { return lanState() },
      close() {
        if (closing !== undefined) return closing
        stopped = true
        clearTimeout(timer)
        lifetime.abort()
        management.dispose()
        eac.dispose()
        runtime.dispose()
        closing = (async () => {
          try {
            await relayChanges
            await Promise.all([closeRelay(), listener.close(), channels.close()])
          } finally {
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
    await relayChanges
    await closeRelay()
    if (listener) await listener.close()
    await channels?.close()
    try { stores?.dispose() } finally { await releaseLock() }
    throw error
  }
}
