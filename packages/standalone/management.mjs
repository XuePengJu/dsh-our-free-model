import { modelAvailability } from '../../src/model-test.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { buildStats } from '../../src/core/stats.js'
import { COMBO_PREFIX, COMBO_STRATEGIES, comboId, isComboEntry, normalizeCombos } from '../../src/combos.js'
import { generateKey } from '../../src/forward.js'
import { structuralRejection } from '../../src/trust.js'
import { classifyChannelFailure } from './channel-probe.mjs'
import { openLoginTerminal } from './login-terminal.mjs'
import {
  listWorkbuddyBackups,
  restoreWorkbuddyBackup,
  syncWorkbuddyModels,
  writeWorkbuddyModel,
} from './workbuddy-sync.mjs'
import { publicModelVisibility, validateModelVisibility, isModelHidden } from '../../src/store.js'

const PREFIX = '/api/management'
const BOOTSTRAP_MS = 10 * 60_000
const SESSION_MS = 8 * 60 * 60_000
const MAX_BODY_BYTES = 16 * 1024
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
])
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

function fail(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

// WorkBuddy 写入地址：允许管理页把「当前访问的域名/IP」作为接入地址写进 ~/.workbuddy/models.json。
// 仅接受无路径、无查询的 http(s) 源地址（origin），其余一律回退服务端绑定地址。
function resolveWorkbuddyBase(requested, fallback) {
  if (requested === undefined || requested === null || requested === '') return fallback
  if (typeof requested !== 'string') throw fail(400, 'baseUrl 必须是不带路径的 http(s) 源地址')
  let parsed
  try { parsed = new URL(requested) } catch { throw fail(400, 'baseUrl 必须是不带路径的 http(s) 源地址') }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== requested) {
    throw fail(400, 'baseUrl 必须是不带路径的 http(s) 源地址')
  }
  return requested
}

function matches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected === '') return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw fail(415, '请求必须使用 application/json')
  }
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw fail(413, '请求内容过大')
    chunks.push(chunk)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fail(400, '请求不是有效 JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(400, '请求必须是 JSON 对象')
  return value
}

function validateSettings(patch) {
  const visibility = validateModelVisibility(patch)
  const booleans = new Set(['enabled', 'exposeRegionModels', 'streamRecovery', 'standaloneProbe', 'standaloneLanEnabled'])
  const numbers = { probeIntervalMinutes: [1, 1440], defaultMaxTokens: [512, 131072], standaloneLanPort: [0, 65535] }
  const result = {}
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(visibility, key)) { result[key] = visibility[key]; continue }
    if (booleans.has(key)) {
      if (typeof value !== 'boolean') throw fail(400, `${key} 必须是布尔值`)
    } else if (Object.hasOwn(numbers, key)) {
      const [min, max] = numbers[key]
      if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `${key} 必须是 ${min} 到 ${max} 的整数`)
    } else throw fail(400, `不支持的设置字段：${key}`)
    result[key] = value
  }
  return result
}

/** 模型组（combo）的表单校验：字段全部来自页面输入，按不受信任处理。 */
function validateCombo(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '' || name.length > 60) throw fail(400, '请输入 60 字以内的模型组名称')
  const id = typeof body.id === 'string' && body.id.startsWith(COMBO_PREFIX) ? body.id : comboId(name)
  if (id === '') throw fail(400, '模型组名称无法生成有效标识，请换一个名称')
  const models = [...new Set((Array.isArray(body.models) ? body.models : [])
    .map(value => String(value ?? '').trim())
    .filter(value => value !== ''))]
  if (models.length === 0) throw fail(400, '请至少勾选一个模型')
  if (models.length > 32) throw fail(400, '一条链最多 32 个模型')
  if (models.some(value => value.length > 300)) throw fail(400, '模型 ID 过长')
  if (models.includes(id)) throw fail(400, '模型组不能包含它自己')
  const strategy = body.strategy === undefined ? 'fallback' : body.strategy
  if (!COMBO_STRATEGIES.includes(strategy)) throw fail(400, '调度策略必须是 fallback 或 round-robin')
  const stickyLimit = body.stickyLimit === undefined ? 1 : Number(body.stickyLimit)
  if (!Number.isInteger(stickyLimit) || stickyLimit < 1 || stickyLimit > 64) throw fail(400, '粘滞轮数必须是 1 到 64 的整数')
  return { id, name, models, strategy, stickyLimit, enabled: body.enabled !== false }
}

export function managementSettings(value) {
  return {
    ...publicModelVisibility(value),
    enabled: value.enabled !== false,
    exposeRegionModels: value.exposeRegionModels !== false,
    streamRecovery: value.streamRecovery !== false,
    standaloneProbe: value.standaloneProbe === true,
    standaloneLanEnabled: value.standaloneLanEnabled === true,
    standaloneLanPort: value.standaloneLanPort ?? 0,
    probeIntervalMinutes: value.probeIntervalMinutes ?? 15,
    defaultMaxTokens: value.defaultMaxTokens ?? 32768,
  }
}

/** 管理读写要求鉴权；登录恢复仅允许同源页面触发固定本机动作。 */
export function createManagement({ stores, runtime, channels, eac, info, onSettingsChanged, loginTerminal = openLoginTerminal, log = () => {} }) {
  let bootstrap = { token: crypto.randomBytes(32).toString('base64url'), until: Date.now() + BOOTSTRAP_MS }
  const sessions = new Map()
  let cookieName
  let closed = false
  let terminalOpening = false
  let terminalOpenedAt = null
  const loginPlatform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported'
  const assets = new Map([...ASSETS].map(([url, [file, type]]) => [
    url, { type, body: file === 'index.html'
      ? Buffer.from(fs.readFileSync(new URL(`./web/${file}`, import.meta.url), 'utf8')
        .replace('data-login-platform="unsupported"', `data-login-platform="${loginPlatform}"`))
      : fs.readFileSync(new URL(`./web/${file}`, import.meta.url)) },
  ]))
  // 只公开构建清单中经过路径校验的 JS/CSS，绝不按请求路径读取磁盘。
  const manifest = JSON.parse(fs.readFileSync(new URL('./web/assets.json', import.meta.url), 'utf8'))
  if (!Array.isArray(manifest) || manifest.some(name => typeof name !== 'string' || !/^[\w-]+\.(js|css)$/.test(name))) {
    throw new Error('独立端资源清单无效')
  }
  for (const name of manifest) assets.set(`/assets/${name}`, {
    type: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
    body: fs.readFileSync(new URL(`./web/${name}`, import.meta.url)),
  })
  const json = (res, status, payload, headers = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(payload))
  }
  const cookie = req => {
    const parts = String(req.headers.cookie ?? '').split(';')
    return parts.map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  }
  const clearCookie = () => `${cookieName}=; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=0`
  const pruneSessions = () => {
    for (const [id, until] of sessions) if (until <= Date.now()) sessions.delete(id)
  }
  const authenticated = req => {
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]
    if (matches(bearer, stores.settings.get().forwardKey)) return true
    pruneSessions()
    return sessions.has(cookie(req))
  }
  const persist = patch => {
    const previous = stores.settings.get()
    stores.settings.update(patch)
    stores.settings.flush()
    if (stores.settings.writeFailed) {
      // 不向页面谎报保存成功；保留原运行配置并由后续写入重试落盘。
      stores.settings.value = previous
      throw fail(500, '无法保存设置，请检查数据目录权限和磁盘空间')
    }
  }
  // 一次显式测试/探测的判定写回 availability 存储：页面徽章与探测链路读的是
  // 同一份数据，写在这里就不会出现「测试成功但徽章不动」的两套口径。
  const recordVerdict = (id, verdict) => {
    stores.availability.edit(value => ({
      ...value,
      results: {
        ...value.results,
        [id]: {
          state: verdict.state,
          ...verdict.detail === undefined ? {} : { detail: verdict.detail },
          ...verdict.ttftMs === undefined ? {} : { ttftMs: verdict.ttftMs },
          latencyMs: verdict.latencyMs, at: Date.now(),
        },
      },
    }))
    stores.availability.flush()
  }
  const summary = () => {
    const state = runtime.state()
    const available = stores.availability.get()
    const routable = new Set(runtime.publicModelRows().map(entry => entry.id))
    const disabledRaw = stores.settings.get().disabledModels
    const disabled = new Set(Array.isArray(disabledRaw) ? disabledRaw : [])
    return {
      ...info(),
      channels: channels?.state(),
      eacAuth: eac?.cached(),
      settings: managementSettings(stores.settings.get()),
      catalogSyncedAt: stores.settings.get().catalogSyncedAt ?? 0,
      probedAt: available.at ?? 0,
      catalog: state.catalog.map(entry => {
        const measured = modelAvailability(entry.id, available, Boolean(entry.channel))
        return ({
        id: entry.id, name: entry.name, channel: entry.channel ?? 'anonymous',
        vision: entry.vision === true, reasoning: entry.reasoning === true || (entry.reasoning !== null && typeof entry.reasoning === 'object'),
        contextWindow: entry.contextWindow ?? entry.context_window, maxOutput: entry.maxOutput ?? entry.max_tokens,
        routable: routable.has(entry.id),
        disabled: disabled.has(entry.id),
        hiddenByUser: isModelHidden(entry, state.settings),
        hiddenByGroup: isModelHidden(entry, { ...state.settings, hiddenModelIds: [] }),
        // 判定来源统一走 modelAvailability：它按请求开始时间比较自动探测与
        // 手工实测，手工结果不会被迟到的旧探测覆盖。渠道行在无任何判定时
        // 仍呈现「清单已收录」（listing），而不是「未探测」。
        ...measured,
        availability: measured.availabilitySource === 'listing' ? 'listed' : measured.availability,
        // 判定原文（如「…均在限流中，最近一个将于 … 解禁」）：徽章只放得下状态名，
        // 失败原因靠它在页面上展开，用户才知道该等解禁还是该去重新登录。
        availabilityDetail: measured.detail || null,
        ttftMs: measured.ttftMs ?? null,
      }) }),
    }
  }

  async function route(req, res, pathname) {
    const method = req.method ?? 'GET'
    if (method === 'POST' && pathname === `${PREFIX}/login/terminal`) {
      // 此入口发生在登录前，必须有浏览器的同源 Origin，拒绝跨站和无来源调用。
      if (req.headers.origin !== new URL(`http://${req.headers.host}`).origin ||
          req.headers['sec-fetch-site'] !== 'same-origin') {
        throw fail(403, '请从本机登录页面点击获取令牌')
      }
      const body = await readBody(req)
      if (Object.keys(body).length !== 0) throw fail(400, '获取令牌不接受路径或命令参数')
      if (terminalOpening || (terminalOpenedAt !== null && Date.now() - terminalOpenedAt < 30_000)) {
        throw fail(429, '已请求打开终端，请检查弹出的窗口，30 秒后可重试')
      }
      terminalOpening = true
      try {
        await loginTerminal(info().dataDir)
        terminalOpenedAt = Date.now()
        json(res, 200, { ok: true })
      } finally { terminalOpening = false }
      return
    }
    if (method === 'POST' && pathname === `${PREFIX}/session`) {
      const body = await readBody(req)
      const validBootstrap = bootstrap !== null && bootstrap.until > Date.now() && matches(body.bootstrapToken, bootstrap.token)
      if (!validBootstrap && !matches(body.key, stores.settings.get().forwardKey)) throw fail(401, '登录链接已失效或 API Key 不正确')
      pruneSessions()
      if (sessions.size >= 64) throw fail(429, '管理会话过多，请稍后重试')
      if (validBootstrap) bootstrap = null
      const id = crypto.randomBytes(32).toString('base64url')
      sessions.set(id, Date.now() + SESSION_MS)
      json(res, 200, { ok: true }, {
        'set-cookie': `${cookieName}=${id}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`,
      })
      return
    }
    if (method === 'GET' && pathname === `${PREFIX}/local-key`) {
      // 登录前自动读取本机令牌：仅允许“本机直连回环服务”的登录页。两层判据：
      // ① 显式部署声明：反代环境（如阿里云 systemd 单元）设 OFM_BEHIND_PROXY=1，
      //    本机令牌自动登录整体关闭，一律手动填 Key——不依赖任何请求头，代理配置
      //    变化也骗不动它，是最稳的一道；任意非空值都视为“已声明”（宁可更严不误放）。
      // ② 转发头兜底：Host 经反代会被改写回 127.0.0.1，光看 Host 分不出本机与远程；
      //    可靠的区分信号是反代注入的 X-Forwarded-For / X-Real-IP / X-Forwarded-Proto
      //    ——nginx 用 proxy_set_header 强制覆盖，远程调用者伪造不出“缺失”，
      //    本机直连则天然没有这些头，不会误拒。
      // 另保留 ③ sec-fetch-site=same-origin（页面自身发起）与 ④ Host 为回环名
      // （防 DNS rebinding 把恶意页面变成“同源”）。
      if (String(process.env.OFM_BEHIND_PROXY ?? '').trim() !== '') throw fail(403, '部署已声明位于反向代理之后，请手动输入 API Key 登录')
      for (const header of ['x-forwarded-for', 'x-real-ip', 'x-forwarded-proto']) {
        if (req.headers[header] !== undefined) throw fail(403, '经反向代理的请求不允许自动读取本机令牌')
      }
      if (req.headers['sec-fetch-site'] !== 'same-origin') throw fail(403, '仅限本机登录页面读取令牌')
      const hostHeader = String(req.headers.host ?? '')
      const hostname = hostHeader.startsWith('[')
        ? hostHeader.slice(1, hostHeader.indexOf(']'))
        : hostHeader.replace(/:\d+$/, '')
      if (!(hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost')) {
        throw fail(403, '仅限回环地址访问')
      }
      json(res, 200, { key: stores.settings.get().forwardKey })
      return
    }
    if (!authenticated(req)) throw fail(401, '请先登录管理页面')
    if (method === 'POST' && pathname === `${PREFIX}/logout`) {
      await readBody(req)
      sessions.delete(cookie(req))
      json(res, 200, { ok: true }, { 'set-cookie': clearCookie() })
    } else if (method === 'GET' && pathname === `${PREFIX}/summary`) {
      json(res, 200, summary())
    } else if (method === 'GET' && pathname === `${PREFIX}/stats`) {
      json(res, 200, buildStats(stores.stats.get(), runtime.catalog))
    } else if (method === 'POST' && pathname === `${PREFIX}/channels/rpc` && channels) {
      // 渠道备份导入包含多账号凭据，仍限制总大小，但不能套设置表单的 16KB。
      const body = await readBody(req, 8 * 1024 * 1024)
      if (body.method === 'gateway.getEnabled' || body.method === 'gateway.setEnabled') {
        if (body.method === 'gateway.setEnabled') {
          if (typeof body.payload?.enabled !== 'boolean') throw fail(400, 'enabled 必须是布尔值')
          persist({ enabled: body.payload.enabled })
          await onSettingsChanged()
        }
        const base = new URL(info().baseUrl)
        json(res, 200, { ok: true, value: {
          enabled: stores.settings.get().enabled !== false, running: stores.settings.get().enabled !== false,
          blockedByEnv: false, address: { host: base.hostname, port: Number(base.port) },
          apiKey: { value: stores.settings.get().forwardKey, path: `${info().dataDir}/settings.json`, fromEnv: false },
          models: runtime.publicModelRows(), modelsSource: 'catalog',
        } })
      } else {
        const controller = new AbortController()
        const abort = () => controller.abort()
        res.once('close', abort)
        try { json(res, 200, await channels.rpc(body, controller.signal)) }
        finally { res.removeListener('close', abort) }
      }
    } else if (eac && pathname.startsWith(`${PREFIX}/eac/`)) {
      const params = new URL(req.url, 'http://localhost').searchParams
      const route = pathname.slice(PREFIX.length)
      let result
      if (method === 'GET' && route === '/eac/status') result = await eac.status()
      else if (method === 'GET' && route === '/eac/login/poll') result = await eac.poll(params.get('link') ?? '')
      else if (method === 'GET' && route === '/eac/pool') result = await eac.pool()
      else if (method === 'POST') {
        await readBody(req)
        if (route === '/eac/login/start') result = await eac.start()
        else if (route === '/eac/login/cancel') result = eac.cancel(params.get('link') ?? '')
        else if (route === '/eac/logout') result = await eac.logout()
      }
      if (result === undefined) throw fail(404, 'EAC 接口不存在')
      if (result.error) throw fail(502, result.error)
      if (result.ok === false) throw fail(500, '无法移除本地授权')
      json(res, 200, result)
    } else if (method === 'POST' && pathname === `${PREFIX}/settings`) {
      const patch = validateSettings(await readBody(req))
      persist(patch)
      await onSettingsChanged()
      json(res, 200, { settings: managementSettings(stores.settings.get()), lan: info().lan })
    } else if (method === 'GET' && pathname === `${PREFIX}/lan/key`) {
      json(res, 200, { key: stores.settings.get().standaloneLanKey ?? '' })
    } else if (method === 'POST' && pathname === `${PREFIX}/lan/key/rotate`) {
      const body = await readBody(req)
      if (body.confirm !== true || Object.keys(body).length !== 1) throw fail(400, 'LAN key rotation requires only confirm: true')
      persist({ standaloneLanKey: generateKey() })
      json(res, 200, { key: stores.settings.get().standaloneLanKey })
    } else if (method === 'GET' && pathname === `${PREFIX}/key`) {
      json(res, 200, { key: stores.settings.get().forwardKey })
    } else if (method === 'POST' && pathname === `${PREFIX}/key/rotate`) {
      const body = await readBody(req)
      if (body.confirm !== true) throw fail(400, '请确认轮换 API Key')
      const id = cookie(req)
      persist({ forwardKey: generateKey() })
      // 仅当前管理会话保留；旧密钥与其他会话立即失效。
      const until = sessions.get(id)
      sessions.clear()
      if (until) sessions.set(id, until)
      bootstrap = null
      json(res, 200, { key: stores.settings.get().forwardKey })
    } else if (method === 'GET' && pathname === `${PREFIX}/combos`) {
      json(res, 200, { combos: normalizeCombos(stores.settings.get().combos) })
    } else if (method === 'POST' && pathname === `${PREFIX}/combos`) {
      const body = await readBody(req)
      const combo = validateCombo(body)
      const combos = normalizeCombos(stores.settings.get().combos)
      if (typeof body.id === 'string' && body.id.startsWith(COMBO_PREFIX)) {
        const index = combos.findIndex(row => row.id === body.id)
        if (index < 0) throw fail(404, '要编辑的模型组不存在')
        combos[index] = combo
      } else {
        if (combos.some(row => row.id === combo.id)) throw fail(409, '同名模型组已存在，请换一个名称')
        combos.push(combo)
      }
      persist({ combos })
      // 组合行由 service 层按 settings 现算，落盘即生效，无需刷新目录。
      json(res, 200, { combos })
    } else if (method === 'POST' && pathname === `${PREFIX}/combos/delete`) {
      const body = await readBody(req)
      if (typeof body.id !== 'string' || !body.id.startsWith(COMBO_PREFIX)) throw fail(400, '请提供要删除的模型组')
      const before = normalizeCombos(stores.settings.get().combos)
      const combos = before.filter(row => row.id !== body.id)
      if (combos.length === before.length) throw fail(404, '模型组不存在')
      persist({ combos })
      json(res, 200, { combos })
    } else if (method === 'POST' && pathname === `${PREFIX}/combos/export-workbuddy`) {
      // 幂等全量同步：启用且可解析的模型组 upsert 进 ~/.workbuddy/models.json，
      // 顺带刷新归属单模型条目并清理 combo: 残留；详见 workbuddy-sync.mjs。
      // 可选 body.baseUrl：把写入条目的接入地址切到管理页当前访问的域名/IP。
      // 可选 body.target === 'ai'：写入 WorkBuddy AI 国际版（~/.workbuddy-ai/models.json），默认写 ~/.workbuddy。
      const body = await readBody(req)
      const settings = stores.settings.get()
      const result = await syncWorkbuddyModels({
        combos: normalizeCombos(settings.combos), catalog: runtime.catalog,
        baseUrl: resolveWorkbuddyBase(body.baseUrl, info().baseUrl), forwardKey: settings.forwardKey,
        dirName: body.target === 'ai' ? '.workbuddy-ai' : undefined,
      })
      json(res, 200, result)
    } else if (method === 'POST' && pathname === `${PREFIX}/models/export-workbuddy`) {
      // 单模型 upsert：只写这一个条目，不清理任何其他条目（无二次确认）。
      // 可选 body.baseUrl：同上，跟随管理页选择的接入地址。
      // 可选 body.target === 'ai'：写入 WorkBuddy AI 国际版（~/.workbuddy-ai/models.json），默认写 ~/.workbuddy。
      const body = await readBody(req)
      const baseUrl = resolveWorkbuddyBase(body.baseUrl, info().baseUrl)
      const dirName = body.target === 'ai' ? '.workbuddy-ai' : undefined
      if (typeof body.id !== 'string' || body.id === '' || body.id.length > 300) throw fail(400, '请提供有效的模型 ID')
      const model = runtime.catalog.find(row => row.id === body.id && !isComboEntry(row))
      if (!model) throw fail(404, '模型清单中没有这个模型')
      const result = await writeWorkbuddyModel({
        model, baseUrl, forwardKey: stores.settings.get().forwardKey, dirName,
      })
      json(res, 200, result)
    } else if (method === 'GET' && pathname === `${PREFIX}/workbuddy/backups`) {
      json(res, 200, { backups: await listWorkbuddyBackups() })
    } else if (method === 'POST' && pathname === `${PREFIX}/workbuddy/backups/restore`) {
      const body = await readBody(req)
      if (typeof body.file !== 'string') throw fail(400, '请提供要恢复的备份文件名')
      json(res, 200, await restoreWorkbuddyBackup(body.file))
    } else if (method === 'POST' && pathname === `${PREFIX}/models/disabled`) {
      // 模型开关：关闭后从公开清单、推理路由、组合链与默认视图中统一剔除，
      // 仅保留在目录里供「已关闭」页展示与一键恢复。
      const body = await readBody(req)
      if (typeof body.id !== 'string' || body.id === '' || body.id.length > 300) throw fail(400, '请提供有效的模型 ID')
      if (typeof body.disabled !== 'boolean') throw fail(400, 'disabled 必须是布尔值')
      if (body.disabled && body.id.startsWith(COMBO_PREFIX)) throw fail(400, '模型组请在「模型组」页面启停')
      if (body.disabled && !runtime.catalog.some(entry => entry.id === body.id)) throw fail(404, '模型清单中没有这个模型')
      const previous = stores.settings.get().disabledModels
      const before = Array.isArray(previous) ? previous : []
      const disabledModels = body.disabled ? [...new Set([...before, body.id])] : before.filter(id => id !== body.id)
      if (disabledModels.length === before.length && body.disabled) {
        json(res, 200, { disabledModels })
        return
      }
      persist({ disabledModels })
      json(res, 200, { disabledModels })
    } else if (method === 'POST' && pathname === `${PREFIX}/models/refresh`) {
      const body = await readBody(req)
      if (body.probe !== undefined && typeof body.probe !== 'boolean') throw fail(400, 'probe 必须是布尔值')
      await runtime.refreshCatalog({ probe: body.probe === true, force: body.probe === true })
      json(res, 200, summary())
    } else if (method === 'POST' && pathname === `${PREFIX}/models/test`) {
      const body = await readBody(req)
      if (stores.settings.get().enabled === false) throw fail(503, '推理服务已暂停，请先在服务设置中启用')
      if (typeof body.model !== 'string' || body.model.length > 300) throw fail(400, '请选择有效模型')
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.once('close', abort)
      try {
        // 走 runtime.testModel：它要求「非空正文 + 正常结束」才判成功，并把
        // 成功/失败都写进 manualResults（与自动探测分开存，旧探测不能覆盖）。
        // 总预算 300 秒由 src/model-test.js 统一管，这里不再自带 60 秒截止。
        const result = await runtime.testModel(body.model, undefined, { signal: controller.signal })
        if (!controller.signal.aborted) json(res, 200, result)
      } catch (error) {
        if (!controller.signal.aborted) {
          // 渠道层抛出的错误（凭据失效、限流、配额耗尽、上游拒绝）不该变成 500
          // 「管理操作失败」——那会把真实原因吞掉，用户在页面上完全看不到为什么
          // 测试失败。凡是在渠道边界标记过的判定，按 502 透传原始消息。
          if (!error?.statusCode && (error?.name === 'LlmError' || error?.channelVerdict === true)) {
            throw fail(502, error.message)
          }
          throw fail(error.status === 404 ? 404 : error.code === 'TIMEOUT' ? 504 : 502, String(error.message ?? '模型测试失败'))
        }
      } finally {
        res.removeListener('close', abort)
      }
    } else throw fail(404, '管理接口不存在')
  }

  return {
    setPort(port) { cookieName = `ofm_management_${port}` },
    get bootstrapFragment() { return bootstrap === null ? '' : `#login=${bootstrap.token}` },
    async handleRequest(req, res) {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const asset = assets.get(pathname)
      const isApi = pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)
      if (!asset && !isApi) return false
      // 不接受插件专用 dsh-app Referer；独立管理只允许本页面的 HTTP 来源。
      const referer = req.headers.referer
      const origin = req.headers.origin
      const malformedSource = [referer, origin].some(value => value !== undefined && (
        typeof value !== 'string' || !value.startsWith('http://')
      ))
      if (closed || !cookieName) json(res, 503, { error: '服务正在停止或启动' })
      else if (malformedSource || structuralRejection(req) !== undefined) json(res, 403, { error: '管理接口仅允许本机同源访问' })
      else if (asset) {
        if (req.method !== 'GET' && req.method !== 'HEAD') json(res, 405, { error: '资源仅支持 GET 或 HEAD' })
        else {
          res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset.type })
          res.end(req.method === 'HEAD' ? undefined : asset.body)
        }
      } else {
        try { await route(req, res, pathname) } catch (error) {
          // 管理路由此前完全不落日志：测试/探测失败只回一句「管理操作失败」，
          // 真实原因（凭据失效、配额耗尽、上游拒绝）彻底消失，排障只能靠猜。
          // 5xx 与服务端异常一律留痕；4xx 是正常的输入校验，不写日志免得刷屏。
          const status = Number(error?.statusCode) || 500
          if (status >= 500) log(`${req.method ?? 'GET'} ${pathname} 失败: ${error?.message ?? error}`)
          if (!res.destroyed && !res.headersSent) json(res, status, {
            error: error.statusCode ? error.message : '管理操作失败，请查看服务日志',
          })
        }
      }
      return true
    },
    dispose() { closed = true; bootstrap = null; sessions.clear() },
  }
}
