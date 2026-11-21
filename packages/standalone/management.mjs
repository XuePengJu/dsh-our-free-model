import { modelAvailability } from '../../src/model-test.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { buildStats } from '../../src/core/stats.js'
import { ATTEMPT_LIMIT, readAttempts } from '../../src/core/attempts.js'
import { COMBO_PREFIX, COMBO_STRATEGIES, comboId, isComboEntry, normalizeCombos } from '../../src/combos.js'
import { ALIAS_MAX_LEN, ALIAS_MODES, aliasFromName, buildAliasRows, normalizeAliasSettings, publicAliasSettings, suggestedAlias } from '../../src/aliases.js'
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
import { createWorkbench } from './workbench.mjs'
import { createProviderManagement } from './providers.mjs'
import { createWorkbenchLibrary } from './library.mjs'
import { createRoutingManagement } from './routing.mjs'
import { createDesktopUpdater } from './desktop-update.mjs'
import { createFeedback } from './feedback.mjs'
import { DISCLAIMER, DISCLAIMER_VERSION, disclaimerAcknowledged } from '../../src/disclaimer.js'
import { pageBridgeSource } from '../../src/plugins.js'

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

/**
 * 解析整型查询参数并钳到 `[min, max]`。
 * 缺省 / 非数字 / 空串一律用 `fallback`；小数截断，不做四舍五入
 * （limit 这类参数宁少勿多，防止一次拉爆 worker 的序列化预算）。
 */
function clampInt(raw, fallback, min, max) {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
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
  const booleans = new Set(['enabled', 'exposeRegionModels', 'streamRecovery', 'standaloneProbe', 'standaloneLanEnabled', 'developerPlugins', 'autoUpdateExtensions'])
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
    /** `/v1/models` 对外用哪套名字：alias（默认）/ both / id。见 src/aliases.js。 */
    aliasMode: normalizeAliasSettings(value.aliases).mode,

    developerPlugins: value.developerPlugins === true,
    autoUpdateExtensions: value.autoUpdateExtensions === true,
  }
}

/** 管理读写要求鉴权；登录恢复仅允许同源页面触发固定本机动作。 */
export function createManagement({ stores, runtime, channels, eac, subscriptions, workbenchOptions, magpieEngine, magpieModels, extensions, onEngineStarted, onSubscriptionsChanged, info, onSettingsChanged, loginTerminal = openLoginTerminal, desktopPlatform = process.platform, desktopArch = process.arch, log = () => {} }) {
  // `desktopPlatform`/`desktopArch` are threaded from the caller instead of read
  // from `process` so the Windows-only update flow stays exercisable on a test
  // runner that is neither (`desktop-update.mjs` already takes them this way).
  const desktopUpdate = createDesktopUpdater({ dataDir: info().dataDir, version: process.env.OFM_DESKTOP_VERSION, platform: desktopPlatform, arch: desktopArch })
  let bootstrap = { token: crypto.randomBytes(32).toString('base64url'), until: Date.now() + BOOTSTRAP_MS }
  const sessions = new Map()
  const privilegedSessions = new Set()
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
    for (const [id, until] of sessions) if (until <= Date.now()) {
      sessions.delete(id)
      privilegedSessions.delete(id)
    }
  }
  /**
   * Sliding renewal: an active console session never expires mid-use.
   *
   * A fixed 8h deadline killed the page while the user was looking at it
   * (issue #557) — the cookie outlived the server-side record, so the next
   * request 401'd with no way to recover but a manual re-login. Touching the
   * record on each authenticated request keeps an idle console expiring on
   * schedule while a busy one stays alive. The cookie's `Max-Age` is not
   * rewritten here, so a closed tab still drops the session within 8h.
   */
  const touchSession = id => {
    if (typeof id !== 'string' || id === '') return
    const until = sessions.get(id)
    if (until === undefined) return
    const renewed = Date.now() + SESSION_MS
    // Only write when the extension is meaningful, so a busy console does not
    // rewrite the map on every request.
    if (renewed - until > 60_000) sessions.set(id, renewed)
  }
  const authenticated = req => {
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]
    if (matches(bearer, stores.settings.get().forwardKey)) return true
    pruneSessions()
    const id = cookie(req)
    touchSession(id)
    return sessions.has(id)
  }
  const sessionAuthenticated = req => {
    pruneSessions()
    const id = cookie(req)
    touchSession(id)
    return sessions.has(id) && privilegedSessions.has(id)
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


  const workbench = runtime && typeof info().dataDir === 'string' ? createWorkbench({
    dataDir: info().dataDir,
    info: () => ({ ...info(), enabled: stores.settings.get().enabled !== false }),
    key: () => stores.settings.get().forwardKey,
    modelRows: () => runtime.publicModelRows(),
    ...workbenchOptions,
  }) : undefined
  const providerManagement = runtime ? createProviderManagement({ stores, runtime, persist }) : undefined
  const routingManagement = runtime ? createRoutingManagement({ stores, runtime, persist }) : undefined
  const library = workbench ? createWorkbenchLibrary({ dataDir: info().dataDir, workbench }) : undefined
  const feedback = createFeedback({ settings: () => stores.settings.get(), persist })
  workbench?.setLibrary(library)
  const summary = () => {
    const state = runtime.state()
    const available = stores.availability.get()
    // 别名行对外只有一个名字，但问卷「这行能不能接入」要按它的真实 id 回答：
    // 否则 `alias` 模式下原 id 全被标成「未公开」，清单页会自相矛盾。
    const routable = new Set(runtime.publicModelRows().map(entry => entry.x_ofm_alias_of ?? entry.id))
    const aliasByTarget = new Map((runtime.aliasRows?.() ?? []).map(row => [row.target, row.alias]))
    const disabledRaw = stores.settings.get().disabledModels
    const disabled = new Set(Array.isArray(disabledRaw) ? disabledRaw : [])
    return {
      ...info(),
      channels: channels?.state(),
      eacAuth: eac?.cached(),
      settings: managementSettings(stores.settings.get()),
      catalogSyncedAt: stores.settings.get().catalogSyncedAt ?? 0,
      probedAt: available.at ?? 0,
      lane: available.lane ?? null,
      extensions: extensions !== undefined ? { installed: extensions.listInstalled() } : null,
      plugins: extensions !== undefined ? {
        installedCount: extensions.listInstalled().filter(record => record.builtin !== true).length,
        builtinCount: extensions.listInstalled().filter(record => record.builtin === true).length,
        pages: extensions.pages(),
        developerPlugins: stores.settings.get().developerPlugins === true,
      } : null,
      catalog: state.catalog.map(entry => {
        // 渠道行是本服务**真实探测**的车道（probeChannelModels 把判定写进 results），
        // 不能像 EAC / Kilo / 聚合车道那样当「只信清单、不做探测」的 listing 车道
        // 传给 modelAvailability —— 第三个参数为 true 时它会直接丢弃 results
        // （`const probe = listed ? undefined : ...`），页面就永远停在「清单已收录」，
        // 点多少次「探测可用性」都不动。只有**一条判定都没有**的渠道行才回落到
        // listing，保住原来那句「清单已收录」而不是「未探测」。
        const hasVerdict = Boolean(available.results?.[entry.id] || available.manualResults?.[entry.id])
        const measured = entry.channel && !hasVerdict
          ? { availabilitySource: 'listing', availability: 'unknown', detail: '', probedAt: 0 }
          : modelAvailability(entry.id, available, false)
        return ({
        id: entry.id, name: entry.name, channel: entry.channel ?? 'anonymous',
        // 可读别名（`qwen3.8-max`）：清单页直接显示它，用户不必抄 `qodercn/qmodel_38max`。
        // 禁用/无可用别名时为空串，页面回退显示原 id。
        alias: aliasByTarget.get(entry.id) ?? '',
        vision: entry.vision === true, reasoning: entry.reasoning === true || (entry.reasoning !== null && typeof entry.reasoning === 'object'),
        contextWindow: entry.contextWindow ?? entry.context_window, maxOutput: entry.maxOutput ?? entry.max_tokens,
        routable: routable.has(entry.id),
        disabled: disabled.has(entry.id),
        hiddenByUser: isModelHidden(entry, state.settings),
        hiddenByGroup: isModelHidden(entry, { ...state.settings, hiddenModelIds: [] }),
        // 判定来源统一走 modelAvailability：它按请求开始时间比较自动探测与
        // 手工实测，手工结果不会被迟到的旧探测覆盖。
        ...measured,
        availability: measured.availabilitySource === 'listing' ? 'listed' : measured.availability,
        // 判定原文（如「…均在限流中，最近一个将于 … 解禁」）：徽章只放得下状态名，
        // 失败原因靠它在页面上展开，用户才知道该等解禁还是该去重新登录。
        availabilityDetail: measured.detail || null,
        ttftMs: measured.ttftMs ?? null,
      }) }),
    }
  }

  // 与 service 侧同口径：别名按**含禁用行**的全量目录分配，禁用某个模型只是让
  // 那个名字消失（请求 404），绝不会把纯名让给另一个渠道的同名模型。
  const aliasCatalog = () => (runtime.catalog ?? []).filter(row => !isComboEntry(row))
  const aliasPayload = () => {
    const settings = normalizeAliasSettings(stores.settings.get().aliases)
    const active = new Map((runtime.aliasRows?.() ?? []).map(row => [row.target, row]))
    const disabled = new Set(Array.isArray(stores.settings.get().disabledModels) ? stores.settings.get().disabledModels : [])
    const rows = aliasCatalog().map(entry => {
      const override = settings.overrides[entry.id] ?? {}
      const live = active.get(entry.id)
      return {
        target: entry.id,
        name: entry.name ?? entry.id,
        channel: entry.channel ?? 'anonymous',
        alias: live?.alias ?? '',
        suggested: suggestedAlias(entry),
        enabled: override.enabled !== false,
        renamed: override.alias !== undefined,
        routable: live !== undefined && !disabled.has(entry.id),
      }
    })
    return { mode: settings.mode, rows }
  }

  const PLUGIN_ASSET_RE = /^\/api\/management\/plugins\/assets\/([a-f0-9]{32})\/(.+)$/
  const pluginAssetPath = pathname => PLUGIN_ASSET_RE.test(pathname)

  /** The one host script a page plugin may load. It is static, has no secrets,
   *  and only opens the postMessage channel back to this console. */
  function injectPluginBridge(html, source) {
    const tag = `<script src="${source}"></script>`
    const text = String(html)
    if (/<\/head\s*>/i.test(text)) return text.replace(/<\/head\s*>/i, `${tag}</head>`)
    return `${tag}${text}`
  }

  /**
   * Serve one page asset. The URL token is the capability: the iframe has an
   * opaque origin and no session, so authorization is "this file was declared
   * by the plugin this boot minted the token for". Everything else is 404.
   */
  function servePluginAsset(req, res, pathname) {
    const match = PLUGIN_ASSET_RE.exec(pathname)
    if (match === null) { res.writeHead(404); res.end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    const token = match[1]
    let relative
    try { relative = decodeURIComponent(match[2]) } catch { res.writeHead(400); res.end(); return }
    if (relative === '' || relative.includes('..') || relative.includes('\\') || relative.includes('\0')) {
      res.writeHead(404); res.end(); return
    }
    const origin = (() => {
      try { return new URL(info().baseUrl).origin } catch { return `http://${req.headers.host}` }
    })()
    const headers = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
      'content-security-policy': `default-src 'none'; script-src ${origin}; style-src 'unsafe-inline' ${origin}; img-src data: blob: ${origin}; font-src ${origin}; connect-src 'none'; frame-ancestors ${origin}; base-uri 'none'; form-action 'none'`,
    }
    if (relative === '__bridge.js') {
      const body = Buffer.from(pageBridgeSource())
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8', 'content-length': body.length })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    const asset = extensions?.pageAsset(token, relative)
    if (asset === undefined || asset === null) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return }
    let body = asset.bytes
    if (asset.type.startsWith('text/html')) {
      body = Buffer.from(injectPluginBridge(body.toString('utf8'), `/api/management/plugins/assets/${token}/__bridge.js`))
    }
    res.writeHead(200, { ...headers, 'content-type': asset.type, 'content-length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  async function route(req, res, pathname) {

    const method = req.method ?? 'GET'
    const reply = (statusCode, payload, headers) => json(res, statusCode, payload, headers)
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
      const validManagementKey = matches(body.key, stores.settings.get().managementKey)
      if (!validBootstrap && !validManagementKey && !matches(body.key, stores.settings.get().forwardKey)) throw fail(401, '登录链接已失效或登录令牌不正确')
      pruneSessions()
      if (sessions.size >= 64) throw fail(429, '管理会话过多，请稍后重试')
      // The bootstrap link is deliberately single-use (a test pins that: a
      // replayable one-time link is a replayable credential). What #557 asked
      // for is the *session* surviving normal use, which `touchSession` now
      // handles — a live console is renewed on every authenticated request
      // instead of dying at a fixed 8h mark.
      if (validBootstrap) bootstrap = null
      const id = crypto.randomBytes(32).toString('base64url')
      sessions.set(id, Date.now() + SESSION_MS)
      if (validBootstrap || validManagementKey) privilegedSessions.add(id)
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

    const privilegedManagementRoute =
      pathname === `${PREFIX}/desktop-update` || pathname.startsWith(`${PREFIX}/desktop-update/`)
      ||
      pathname === `${PREFIX}/workbench` || pathname.startsWith(`${PREFIX}/workbench/`)
      || pathname === `${PREFIX}/library` || pathname.startsWith(`${PREFIX}/library/`)
      || pathname === `${PREFIX}/providers` || pathname.startsWith(`${PREFIX}/providers/`)
      || pathname === `${PREFIX}/subscriptions` || pathname.startsWith(`${PREFIX}/subscriptions/`)
      || pathname === `${PREFIX}/routing` || pathname.startsWith(`${PREFIX}/routing/`)
      || pathname === `${PREFIX}/engine` || pathname.startsWith(`${PREFIX}/engine/`)
      || pathname === `${PREFIX}/extensions` || pathname.startsWith(`${PREFIX}/extensions/`)
      || pathname === `${PREFIX}/plugins` || pathname.startsWith(`${PREFIX}/plugins/`)
      || pathname === `${PREFIX}/feedback` || pathname.startsWith(`${PREFIX}/feedback/`)
    // A sandboxed plugin page inside the workspace carries a per-run HMAC
    // capability in its own path; it has an opaque origin and cannot send this
    // console's session. The engine validates the capability and serves only
    // that plugin's files, exactly as it does for the plugin build. This has to
    // be decided before the session check for the same reason.
    const enginePluginAsset = ['GET', 'HEAD'].includes(req.method)
      && /^\/api\/management\/engine\/ui\/_magpie\/plugin\/[a-f0-9]{32}\/[^?]+$/.test(pathname)
    const pluginPageAsset = ['GET', 'HEAD'].includes(req.method) && pluginAssetPath(pathname)
    if (!authenticated(req) && !enginePluginAsset && !pluginPageAsset) throw fail(401, '请先登录管理页面')
    if (privilegedManagementRoute && !sessionAuthenticated(req) && !enginePluginAsset && !pluginPageAsset) {
      throw fail(403, '此管理操作需要已登录的本地管理会话')
    }
    // ── the plugin center (behind the same session fence) ────────────────────
    // `/plugins` is the current surface; `/extensions` stays as an alias so an
    // older console and the DSH-side marketplace keep working unchanged.
    const pluginBase = pathname === `${PREFIX}/plugins` || pathname.startsWith(`${PREFIX}/plugins/`)
      ? `${PREFIX}/plugins`
      : pathname === `${PREFIX}/extensions` || pathname.startsWith(`${PREFIX}/extensions/`)
        ? `${PREFIX}/extensions`
        : null
    if (pluginBase !== null) {
      // A composition that mounted no plugin runtime answers "unavailable",
      // never a TypeError.
      if (extensions === undefined) return reply(503, { error: 'the plugin platform is unavailable' })
      const suffix = pathname.slice(pluginBase.length)
      const readJsonBody = () => readBody(req)
      if (method === 'GET' && suffix === '') {
        // A first paint waits briefly for the boot warm-up and hears why a read
        // failed, rather than being told the index is unreadable when it is
        // simply still downloading.
        const status = await extensions.registryStatusSoon()
        return reply(200, {
          installed: extensions.listInstalled(),
          registry: status.registry,
          registryError: status.error,
          pages: extensions.pages(),
          audit: extensions.auditTail(100),
          updates: extensions.updatesAvailable(),
          registryMeta: extensions.registryMeta(),
          settings: {
            developerPlugins: stores.settings.get().developerPlugins === true,
            autoUpdateExtensions: stores.settings.get().autoUpdateExtensions === true,
          },
        })
      }
      if (method === 'GET' && suffix === '/pages') return reply(200, { pages: extensions.pages() })
      if (method === 'GET' && suffix === '/audit') return reply(200, { entries: extensions.auditTail(100) })
      if (method === 'GET' && suffix === '/cover') {
        const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? ''
        const image = await extensions.coverImage(id)
        if (image === null) return reply(404, { error: 'cover not found' })
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': image.contentType, 'content-length': image.bytes.length })
        res.end(image.bytes)
        return
      }
      if (method === 'POST' && suffix === '/registry/refresh') {
        try {
          await extensions.refreshRegistry({ force: true })
          return reply(200, { ok: true, installed: extensions.listInstalled(), registry: extensions.registryView() })
        } catch (error) {
          return reply(502, { error: String(error?.message ?? error), installed: extensions.listInstalled() })
        }
      }
      if (method === 'POST' && suffix === '/install') {
        try {
          const body = await readJsonBody()
          const record = await extensions.install(String(body?.id ?? ''), { version: typeof body?.version === 'string' ? body.version : undefined })
          return reply(200, { ok: true, record, installed: extensions.listInstalled(), pages: extensions.pages() })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/install-local') {
        try {
          if (stores.settings.get().developerPlugins !== true) throw fail(403, '请先在插件中心开启开发者模式')
          const body = await readJsonBody()
          const record = await extensions.installLocal({
            path: String(body?.path ?? ''),
            acknowledgeUnsigned: body?.acknowledgeUnsigned === true,
          })
          return reply(200, { ok: true, record, installed: extensions.listInstalled(), pages: extensions.pages() })
        } catch (error) {
          return reply(error.statusCode ?? 400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/uninstall') {
        try {
          const body = await readJsonBody()
          await extensions.uninstall(String(body?.id ?? ''))
          return reply(200, { ok: true, installed: extensions.listInstalled(), pages: extensions.pages() })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/toggle') {
        try {
          const body = await readJsonBody()
          const record = await extensions.setEnabled(String(body?.id ?? ''), body?.enabled === true)
          return reply(200, { ok: true, record, installed: extensions.listInstalled(), pages: extensions.pages() })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/config') {
        try {
          const body = await readJsonBody()
          const record = await extensions.saveConfig(String(body?.id ?? ''), body?.values ?? {})
          // `installed` rides along so a saved config field is reflected by the
          // card that rendered it.
          return reply(200, { ok: true, record, installed: extensions.listInstalled() })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/secret') {
        try {
          const body = await readJsonBody()
          const record = await extensions.saveSecret(String(body?.id ?? ''), String(body?.key ?? ''), body?.value)
          return reply(200, { ok: true, record, installed: extensions.listInstalled() })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/self-test') {
        try {
          const body = await readJsonBody()
          return reply(200, await extensions.runSelfTest(String(body?.id ?? '')))
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/page-rpc') {
        try {
          const body = await readBody(req, 96 * 1024)
          const result = await extensions.pageRpc(
            String(body?.pluginId ?? ''), String(body?.pageId ?? ''), String(body?.method ?? ''), body?.params ?? {},
          )
          return reply(200, { ok: true, result })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      return reply(404, { error: '插件接口不存在' })
    }

    if (method === 'POST' && pathname === `${PREFIX}/logout`) {
      await readBody(req)
      sessions.delete(cookie(req))
      privilegedSessions.delete(cookie(req))
      json(res, 200, { ok: true }, { 'set-cookie': clearCookie() })
    } else if (pathname === `${PREFIX}/desktop-update` && method === 'GET') {
      json(res, 200, desktopUpdate.status())
    } else if (pathname === `${PREFIX}/desktop-update/check` && method === 'POST') {
      await readBody(req)
      json(res, 200, desktopUpdate.check())
    } else if (pathname === `${PREFIX}/desktop-update/download` && method === 'POST') {
      await readBody(req)
      json(res, 200, desktopUpdate.download())
    } else if (method === 'GET' && pathname === `${PREFIX}/summary`) {
      json(res, 200, summary())
    } else if (method === 'GET' && pathname === `${PREFIX}/stats`) {
      json(res, 200, buildStats(stores.stats.get(), runtime.catalog))
    } else if (method === 'GET' && pathname === `${PREFIX}/usage/ledger`) {
      // 渠道账本跑在 worker 线程里，只能经 channels.rpc 跨线程读；它比 /stats 慢得多
      // （跨线程 + 逐条序列化），所以**不能**并进 app.tsx 的 loadData 整包 Promise.all ——
      // 那会把「渠道 worker 挂了」放大成「整个统计页白屏」。前端有一条独立的钟（6s）。
      //
      // 两个 RPC 都是只读 + 幂等，用 Promise.all 并发，省一半往返；任一路失败整体 502。
      if (!channels) throw fail(503, '渠道服务未连接，用量明细暂不可用')
      const params = new URL(req.url, 'http://localhost').searchParams
      // limit 缺省 500 = 内存账本全量窗口（TOKEN_LEDGER_LIMIT）：前端「今日 / 近 7 天」
      // 要用 `entries` 按 UTC+8 日键重新聚合，窗口比 500 小就会把今天的数据切掉一截，
      // 算出来的合计比 RPC 的树少。500 条明细只含摘要（全文不进内存账本），载荷可接受。
      const limit = clampInt(params.get('limit'), 500, 1, 500)
      const sinceDays = clampInt(params.get('sinceDays'), 90, 1, 90)
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.once('close', abort)
      try {
        const unwrap = async call => {
          let envelope
          try {
            envelope = await channels.rpc(call, controller.signal)
          } catch (error) {
            // worker 已退出 / 序列化失败：统一成 502（上游不可用），不要漏成 500「管理操作失败」
            throw fail(502, error?.message ?? '用量明细读取失败')
          }
          // 信封是 {ok, value} / {ok:false, error:{code,message}}；这一层必须解掉，
          // 让前端拿到扁平结构（高频轮询不值得每次再剥一层）。
          if (envelope?.ok !== true) throw fail(502, envelope?.error?.message ?? '用量明细读取失败')
          return envelope.value
        }
        const [ledger, history] = await Promise.all([
          unwrap({ method: 'usage.tokenLedger', payload: { limit } }),
          unwrap({ method: 'usage.tokenLedgerHistory', payload: { sinceDays } }),
        ])
        // 客户端已经断开（切页/关标签）时不要再写响应：res 的 writeHead 会抛 ERR_STREAM_DESTROYED。
        if (!controller.signal.aborted && !res.destroyed) {
          json(res, 200, {
            snapshot: ledger?.snapshot ?? { channels: [], totals: {}, entries: [] },
            history: Array.isArray(history?.history) ? history.history : [],
            historyTotals: history?.totals ?? {},
            // 前端拿它当「现在」：档位过滤、桶对齐都以服务端时刻为基准，
            // 避免本机时钟偏移把「今日」算到别人的日期上。
            generatedAt: Date.now(),
          })
        }
      } finally { res.removeListener('close', abort) }
    } else if (method === 'GET' && pathname === `${PREFIX}/usage/attempts`) {
      // 降级尝试环住在**本地** stats store 里（harness 与 forward 两条推理路径共写），
      // 所以这条路刻意不走 channels.rpc：渠道 worker 挂掉时它照样要能返回，而
      // /usage/ledger 会 502。两个端点分开，正是为了不让一个坏掉的源把另一个
      // 好源的数据一起拖没。
      const params = new URL(req.url, 'http://localhost').searchParams
      const limit = clampInt(params.get('limit'), ATTEMPT_LIMIT, 1, ATTEMPT_LIMIT)
      let attempts
      let total = 0
      try {
        const value = stores.stats.get()
        total = Array.isArray(value?.attempts) ? value.attempts.length : 0
        attempts = readAttempts(stores.stats, { limit })
      } catch (error) {
        // 本地 store 读不出来只可能是本地异常：500，别伪装成上游的 502/503。
        throw fail(500, error?.message ?? '降级尝试记录读取失败')
      }
      json(res, 200, {
        attempts,
        // total 是环里现有的条数（含被 limit 切掉的部分），前端据此说「显示最近 N 条」。
        total,
        generatedAt: Date.now(),
      })


    } else if (method === 'GET' && pathname === `${PREFIX}/engine/status`) {
      json(res, 200, magpieEngine?.status() ?? { state: 'unavailable', available: false })
    } else if (method === 'POST' && pathname === `${PREFIX}/engine/start`) {
      await readBody(req)
      if (!magpieEngine) throw fail(503, '模型工作台不可用')
      await magpieEngine.start()
      await magpieModels?.refresh()
      onEngineStarted?.()
      json(res, 200, magpieEngine.status())
    } else if (method === 'POST' && pathname === `${PREFIX}/engine/refresh`) {
      await readBody(req)
      if (!magpieEngine) throw fail(503, '模型工作台不可用')
      await magpieModels?.refresh()
      json(res, 200, { ok: true })
    } else if (pathname === `${PREFIX}/engine/ui` || pathname.startsWith(`${PREFIX}/engine/ui/`)) {
      if (!magpieEngine) throw fail(503, '模型工作台不可用')
      if (magpieEngine.status().state !== 'ready') throw fail(503, '模型工作台尚未启动')
      if (pathname === `${PREFIX}/engine/ui` && !req.url.endsWith('/')) {
        res.writeHead(302, { location: `${PREFIX}/engine/ui/` })
        return res.end()
      }
      // The embedded page is same-origin HTML that the engine rewrites for this
      // mount; a POST from it is how the workspace reports a change, and the
      // published catalog has to follow.
      res.once('finish', () => {
        if (req.method === 'POST') void magpieModels?.refresh().catch(() => {})
      })
      const upstream = req.url.slice(PREFIX.length + '/engine/ui'.length) || '/'
      // The engine derives its visible mount from the plugin build's own path
      // (`/api/our-free-model/engine/ui/`). This console mounts the same UI at a
      // different prefix, so both the mount it should treat as its own and the
      // prefix it should emit are passed explicitly instead of guessed.
      const mount = `${PREFIX}/engine/ui/`
      await magpieEngine.proxy(req, res, upstream, { prefix: mount, mount })
      return
    } else if (pathname === `${PREFIX}/workbench` && method === 'GET' && workbench) {
      json(res, 200, { clients: workbench.clients(), accounts: subscriptions?.list() ?? [] })
    } else if (pathname.startsWith(`${PREFIX}/workbench/clients/`) && method === 'POST' && workbench) {
      const body = await readBody(req)
      const action = pathname.slice(`${PREFIX}/workbench/clients/`.length)
      if (action === 'save') json(res, 200, workbench.save(body))
      else if (action === 'launch') json(res, 200, await workbench.launch(body))
      else if (action === 'stop') json(res, 200, await workbench.stop(body))
      else throw fail(404, '客户端操作不存在')
    } else if (pathname === `${PREFIX}/library` && method === 'GET' && library) {
      json(res, 200, library.list())
    } else if (pathname === `${PREFIX}/routing` && method === 'GET' && routingManagement) {
      json(res, 200, routingManagement.list())
    } else if (pathname.startsWith(`${PREFIX}/routing/`) && method === 'POST' && routingManagement) {
      const action = pathname.slice(`${PREFIX}/routing/`.length)
      if (!['save', 'remove', 'preview'].includes(action)) throw fail(404, '路由组操作不存在')
      json(res, 200, routingManagement[action](await readBody(req, 128 * 1024)))
    } else if (pathname.startsWith(`${PREFIX}/library/`) && method === 'POST' && library) {
      const action = pathname.slice(`${PREFIX}/library/`.length)
      const actions = {
        'profiles/save': 'saveProfile', 'profiles/apply': 'applyProfile', 'profiles/remove': 'removeProfile',
        'resources/save': 'saveResource', 'resources/remove': 'removeResource',
      }
      const body = await readBody(req, 1024 * 1024 + 8192)
      if (!Object.hasOwn(actions, action)) throw fail(404, '资源操作不存在')
      json(res, 200, library[actions[action]](body))
    } else if (pathname === `${PREFIX}/providers` && method === 'GET' && providerManagement) {
      json(res, 200, providerManagement.list())
    } else if (pathname.startsWith(`${PREFIX}/providers/`) && method === 'POST' && providerManagement) {
      const action = pathname.slice(`${PREFIX}/providers/`.length)
      const body = await readBody(req, 128 * 1024)
      if (!['save', 'remove', 'test', 'discover'].includes(action)) throw fail(404, '供应商操作不存在')
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.once('close', abort)
      try { json(res, 200, await providerManagement[action](body, controller.signal)) }
      finally { res.removeListener('close', abort) }
    } else if (pathname === `${PREFIX}/subscriptions` && method === 'GET' && subscriptions) {
      json(res, 200, { accounts: subscriptions.list() })
    } else if (pathname === `${PREFIX}/subscriptions/discover` && method === 'GET' && subscriptions) {
      const discovered = await subscriptions.discover()
      json(res, 200, { candidates: [
        { provider: 'codex', label: 'Codex / ChatGPT' },
        { provider: 'claude', label: 'Claude Code' },
        { provider: 'gemini', label: 'Gemini CLI' },
      ].map(row => ({ ...row, available: discovered.some(candidate => candidate.provider === row.provider) })) })
    } else if (pathname.startsWith(`${PREFIX}/subscriptions/`) && method === 'POST' && subscriptions) {
      const action = pathname.slice(`${PREFIX}/subscriptions/`.length)
      const body = await readBody(req, 1024 * 1024)
      if (action === 'import') await subscriptions.import(body)
      else if (action === 'import-local') await subscriptions.importLocal(body)
      else if (action === 'enabled') await subscriptions.setEnabled(body)
      else if (action === 'remove') await subscriptions.remove(body)
      else if (action === 'quota') {
        const controller = new AbortController()
        const abort = () => controller.abort()
        res.once('close', abort)
        try { await subscriptions.refreshQuota({ ...body, signal: controller.signal }) }
        finally { res.removeListener('close', abort) }
      } else throw fail(404, '订阅操作不存在')
      runtime.syncAggregateCatalog()
      json(res, 200, { accounts: subscriptions.list() })
    } else if (method === 'GET' && pathname === `${PREFIX}/feedback`) {
      json(res, 200, feedback.status())
    } else if (method === 'POST' && pathname.startsWith(`${PREFIX}/feedback/`)) {
      const action = pathname.slice(`${PREFIX}/feedback/`.length)
      const body = await readBody(req, 32 * 1024)
      if (action === 'start') json(res, 200, await feedback.start())
      else if (action === 'poll') json(res, 200, await feedback.poll(body))
      else if (action === 'signout') json(res, 200, feedback.signOut())
      else if (action === 'submit') json(res, 200, await feedback.submit(body))
      else throw fail(404, '反馈操作不存在')
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
    } else if (method === 'GET' && pathname === `${PREFIX}/disclaimer`) {
      json(res, 200, { ...DISCLAIMER, acknowledged: disclaimerAcknowledged(stores.settings.get()) })
    } else if (method === 'POST' && pathname === `${PREFIX}/disclaimer/ack`) {
      persist({ disclaimerAck: DISCLAIMER_VERSION })
      json(res, 200, { ok: true, acknowledged: true })
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
      const privileged = privilegedSessions.has(id)
      sessions.clear()
      privilegedSessions.clear()
      if (until) sessions.set(id, until)
      if (until && privileged) privilegedSessions.add(id)
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
    } else if (method === 'GET' && pathname === `${PREFIX}/aliases`) {
      json(res, 200, aliasPayload())
    } else if (method === 'POST' && pathname === `${PREFIX}/aliases`) {
      // 自动别名不写盘：settings 只记「改名」与「关闭」两类覆盖，其余模型继续
      // 跟随目录自动生成，所以渠道新增模型时不需要任何同步动作。
      const body = await readBody(req)
      const current = normalizeAliasSettings(stores.settings.get().aliases)
      if (body.mode !== undefined) {
        if (!ALIAS_MODES.includes(body.mode)) throw fail(400, '对外暴露方式必须是 both、alias 或 id')
        persist({ aliases: { ...current, mode: body.mode } })
        json(res, 200, aliasPayload())
        return
      }
      if (typeof body.target !== 'string' || body.target === '' || body.target.length > 300) throw fail(400, '请提供要设置别名的模型 ID')
      if (!aliasCatalog().some(entry => entry.id === body.target)) throw fail(404, '模型清单中没有这个模型')
      const next = { ...(current.overrides[body.target] ?? { enabled: true }) }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') throw fail(400, 'enabled 必须是布尔值')
        next.enabled = body.enabled
      }
      if (body.alias !== undefined) {
        const alias = aliasFromName(body.alias)
        if (alias === '' || alias.length > ALIAS_MAX_LEN) throw fail(400, `别名需为 ${ALIAS_MAX_LEN} 字符以内的字母、数字、点、下划线或短横线`)
        if (alias === body.target) throw fail(400, '别名不能与模型 ID 相同')
        // 别名的第一条不变量是不含 `/`：渠道按 `provider/` 前缀认路，
        // 带斜杠的名字会被当成渠道 id。aliasFromName 已经把它折成短横线。
        if ((runtime.catalog ?? []).some(row => row.id === alias)) throw fail(409, `「${alias}」已经是另一个模型的 ID`)
        next.alias = alias
      }
      const overrides = { ...current.overrides, [body.target]: next }
      // 试算一次：claim 只因冲突改名，改过的名字不能算用户设置成功。
      if (body.alias !== undefined) {
        const claimed = buildAliasRows(aliasCatalog(), { ...current, overrides }).find(row => row.target === body.target)
        if (claimed !== undefined && claimed.alias !== next.alias) throw fail(409, `「${next.alias}」已被占用，建议改用 ${claimed.alias}`)
      }
      persist({ aliases: { ...current, overrides } })
      json(res, 200, aliasPayload())
    } else if (method === 'POST' && pathname === `${PREFIX}/aliases/reset`) {
      // 清掉覆盖即恢复「跟着目录自动生成」：不带 target 是全部恢复。
      const body = await readBody(req)
      const current = normalizeAliasSettings(stores.settings.get().aliases)
      const overrides = { ...current.overrides }
      if (typeof body.target === 'string' && body.target !== '') {
        if (overrides[body.target] === undefined) throw fail(404, '这个模型没有别名覆盖')
        delete overrides[body.target]
      } else {
        for (const key of Object.keys(overrides)) delete overrides[key]
      }
      persist({ aliases: { ...current, overrides } })
      json(res, 200, aliasPayload())
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
      const { sources } = await runtime.refreshCatalog({ probe: body.probe === true, force: body.probe === true, report: true })
      json(res, 200, { ...summary(), sources })



    } else if (method === 'GET' && pathname === `${PREFIX}/models/probe`) {
      // 探测进度快照：只读内存状态，不触发任何上游请求。前端在「探测可用性」等待
      // 期间短轮询这个接口画进度条——POST /models/refresh 本身要等整轮跑完才返回。
      json(res, 200, runtime.probeProgress?.() ?? { running: false, phase: 'idle', done: 0, total: 0, startedAt: 0, finishedAt: 0 })
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
      const pageAsset = ['GET', 'HEAD'].includes(req.method) && pluginAssetPath(pathname)
      if (!asset && !isApi) return false
      // 不接受插件专用 dsh-app Referer；独立管理只允许本页面的 HTTP 来源。
      const referer = req.headers.referer
      const origin = req.headers.origin
      const malformedSource = [referer, origin].some(value => value !== undefined && (
        typeof value !== 'string' || !value.startsWith('http://')
      ))
      if (closed || !cookieName) json(res, 503, { error: '服务正在停止或启动' })
      // A page asset is a capability URL: the sandboxed iframe has an opaque
      // origin and sends no session. It must be decided before both the
      // same-site source fence and the session check.
      else if (pageAsset) servePluginAsset(req, res, pathname)
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
    dispose() { desktopUpdate.close(); closed = true; bootstrap = null; sessions.clear(); privilegedSessions.clear(); return workbench?.dispose() },
  }
}
