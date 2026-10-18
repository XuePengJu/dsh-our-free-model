/**
 * WorkBuddy 模型配置同步：把本服务的模型组（combo）与单个模型写入
 * `~/.workbuddy/models.json`，供 WorkBuddy 直接以 OpenAI 兼容方式调用本地网关。
 *
 * 两个入口共用同一套机制：
 *
 * - 全量同步（模型组页「同步到 WorkBuddy」）：幂等 upsert 所有启用且可解析的
 *   模型组，顺带刷新已存在的归属单模型条目（防 forwardKey 轮换、端口变更后
 *   静默失效），并清理 `combo:` 前缀的残留条目（已删除/停用/成员全不可用的组）。
 *   单模型条目「刷新但不清理」——写入了哪些单模型由用户逐个决定，服务端无从
 *   推断哪些应该存在，贸然清理会误删。
 * - 单模型写入（模型清单页「写入 WorkBuddy」）：只 upsert 该条目，不清理任何
 *   其他条目。
 *
 * 归属判定（哪些条目归本服务管）：url 为回环地址 且 apiKey 以 `ofm-` 开头
 * （generateKey 的固定前缀），或 id 带 `combo:` 前缀（兼容 v1 期间写入的旧条目）。
 * 归属条目可被覆盖/刷新；但删除只作用于 `combo:` 前缀条目（整文件回滚除外）。
 *
 * 写入安全性：tmp 写成功 → 原文备份到 `models.json.backups/`（保留 20 份）→
 * rename 原子替换。非法 JSON / 顶层非数组一律拒绝写入并明确报错，绝不覆盖。
 *
 * @module packages/standalone/workbuddy-sync.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COMBO_PREFIX, buildComboCatalog, isComboEntry } from '../../src/combos.js'

/** 备份保留份数：超出后按文件名（即创建时间）淘汰最旧的。 */
const BACKUP_KEEP = 20
/** 备份文件名白名单：只接受本模块产出的命名，天然杜绝路径穿越。 */
const BACKUP_NAME = /^models-\d{8}-\d{6}(-\d+)?\.json$/
const DEFAULT_CONTEXT_WINDOW = 131072
const DEFAULT_MAX_OUTPUT = 32768

/**
 * 带状态码的错误：管理路由的统一 catch 按 `statusCode` 原样把具体原因
 * 回给页面（而非笼统的 500「管理操作失败」），满足「拒绝写入并明确报错」。
 */
function syncError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

/** 允许写入的 WorkBuddy 目录变体：默认国际通用目录，`ai` 为 WorkBuddy AI 国际版（~/.workbuddy-ai）。 */
const WORKBUDDY_DIR_NAMES = new Set(['.workbuddy', '.workbuddy-ai'])

function homePaths(homeDir, dirName = '.workbuddy') {
  // 目录名白名单：只接受本模块声明的两个变体，杜绝请求参数拼接出任意路径。
  if (!WORKBUDDY_DIR_NAMES.has(dirName)) throw syncError(400, `不支持的 WorkBuddy 目录：${dirName}`)
  const root = path.join(homeDir ?? os.homedir(), dirName)
  return {
    dir: root,
    file: path.join(root, 'models.json'),
    backups: path.join(root, 'models.json.backups'),
  }
}

function positiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

function isLoopbackUrl(value) {
  try {
    // WHATWG URL 对 IPv6 主机名保留方括号（'[::1]'），比较前剥掉。
    const host = new URL(String(value)).hostname.replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === '::1' || host === 'localhost'
  } catch { return false }
}

/**
 * 归属判定：该条目是否由本服务写入/管理。
 * 不依赖精确 url，因此端口变更后同步会把旧端口条目自愈成当前地址。
 */
export function isOwnedByOfm(entry) {
  return isLoopbackUrl(entry?.url) && (
    String(entry?.apiKey ?? '').startsWith('ofm-') ||
    String(entry?.id ?? '').startsWith(COMBO_PREFIX)
  )
}

/**
 * 模型行自己声明的思考档位表与默认档，读不到的部分不写。
 *
 * 两者都必须以模型行的声明为准，绝不写死：写死会在客户端列出模型根本不接受的
 * 档位，用户选中后要么被网关就近落档（UI 上的档位成了摆设），要么整轮 400；
 * 而**漏掉默认档**会让客户端在用户没手动选档时不下发 `reasoning_effort`，
 * 对「不带档位就不思考」的模型（deepseek 系）表现成「思考一直是关的」。
 *
 * 三种行形态各读一处，都是各自产物的既有字段，不新增推断：
 *
 * - 渠道行（workbuddy/codearts/…）：`reasoning.efforts[].canonical` 就是「这个
 *   私有档位在客户端里该写成哪个规范名」，`openai_efforts` 只是它的机械投影
 *   （见 vendor/channel-pack/src/openai-gateway/effort-view.ts），故直接按行读，
 *   顺带用同一张表把 `reasoning.default` 反查成规范名。
 * - EAC / Kilo 行：`reasoning` 是布尔，档位在同级 `efforts` 里，值是上游私有
 *   id；其中 `disabled` 是「关闭思考」，在规范词汇里对应 `none`
 *   （见 vendor/channel-pack/src/reasoning-ladder.ts 的强度序）。
 * - 免费车道与组合行：只声明「能不能思考」，没有档位表。免费车道的档位是本地
 *   token 阶梯（src/effort.js），网关根本不下发 effort 字段，写成任何档位都是
 *   虚构 —— 故整个字段都不写，客户端按「只有思考开关」处理。
 *
 * 规范名照原样透传（含 `none`/`ultra`）：客户端只渲染它认识的那几档，多写的
 * 值不会误发；而一旦客户端日后补上标签，文件里已有正确值，无需再同步一次。
 *
 * 返回 `undefined` 表示该行没声明档位表（不写 `reasoning`）；
 * 否则返回 `{ supported, defaultEffort }`，其中 `defaultEffort` 仍可能缺省
 * （声明值不在自己的档位表内时，宁可留空交给请求层，也不写一个会被网关就近
 * 落档的档位）。
 */
function reasoningDeclarationFor(model) {
  const reasoning = model?.reasoning
  if (reasoning !== null && typeof reasoning === 'object') {
    const rows = (Array.isArray(reasoning.efforts) ? reasoning.efforts : [])
      .filter(row => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '')
    const canonical = new Map()
    for (const row of rows) {
      if (typeof row.canonical === 'string' && row.canonical !== '') canonical.set(row.id, row.canonical)
    }
    const supported = [...new Set(rows.map(row => canonical.get(row.id)).filter(effort => effort !== undefined))]
    if (supported.length === 0) return undefined
    const declaredDefault = typeof reasoning.default === 'string' ? canonical.get(reasoning.default) : undefined
    return {
      supported,
      defaultEffort: supported.includes(declaredDefault) ? declaredDefault : undefined,
    }
  }
  if (Array.isArray(model?.efforts) && model.efforts.length > 0) {
    const name = effort => (effort === 'disabled' ? 'none' : effort)
    const supported = [...new Set(model.efforts
      .filter(effort => typeof effort === 'string' && effort !== '')
      .map(name))]
    if (supported.length === 0) return undefined
    const declaredDefault = typeof model.effortDefault === 'string' ? name(model.effortDefault) : undefined
    return {
      supported,
      defaultEffort: supported.includes(declaredDefault) ? declaredDefault : undefined,
    }
  }
  return undefined
}

/**
 * 单个模型目录行 → WorkBuddy 条目。模型组（combo 虚拟行）与真实模型行共用：
 * combo 行的 vision/reasoning/contextWindow/maxOutput 已由 buildComboCatalog
 * 算好交集，字段形状与真实模型行一致。
 *
 * `reasoning` 子对象只在拿得到模型自己的档位声明时才写：写一个空档位表等于
 * 宣称「有档位可选」，客户端的选择器会因此空转。
 */
export function buildWorkbuddyEntryFromModel(model, { baseUrl, forwardKey }) {
  const supportsReasoning = model.reasoning === true ||
    (model.reasoning !== null && typeof model.reasoning === 'object')
  const declaration = reasoningDeclarationFor(model)
  return {
    id: String(model.id),
    name: String(model.name ?? model.id),
    vendor: 'Custom',
    url: `${baseUrl}/v1`,
    apiKey: forwardKey,
    supportsToolCall: true,
    supportsImages: model.vision === true,
    supportsReasoning,
    useCustomProtocol: false,
    maxInputTokens: positiveInt(model.contextWindow ?? model.context_window) ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: positiveInt(model.maxOutput ?? model.max_tokens) ?? DEFAULT_MAX_OUTPUT,
    ...(declaration === undefined ? {} : {
      reasoning: {
        supportedEfforts: declaration.supported,
        ...(declaration.defaultEffort === undefined ? {} : { defaultEffort: declaration.defaultEffort }),
      },
    }),
  }
}

/**
 * 启用且可解析的模型组集合 → WorkBuddy 条目列表。
 * buildComboCatalog 已剔除停用组与无可用成员的组，产出即期望全集。
 */
export function buildWorkbuddyEntries({ combos, catalog, baseUrl, forwardKey }) {
  return buildComboCatalog(combos, catalog)
    .map(row => buildWorkbuddyEntryFromModel(row, { baseUrl, forwardKey }))
}

/**
 * 读取 models.json 并做容错：
 * 文件不存在视为空数组；非法 JSON / 顶层非数组 → 拒绝写入并明确报错，
 * 绝不静默覆盖用户手改的配置。数组元素非对象则过滤掉再参与 diff。
 */
function readModelsFile(paths) {
  let raw
  try {
    raw = fs.readFileSync(paths.file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], raw: null, exists: false }
    throw syncError(500, `无法读取 WorkBuddy 配置（${paths.file}）：${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw syncError(409, `WorkBuddy 配置（models.json）不是有效 JSON，已拒绝写入以避免覆盖：${error?.message ?? error}`)
  }
  if (!Array.isArray(parsed)) throw syncError(409, 'WorkBuddy 配置（models.json）顶层必须是数组，已拒绝写入以避免覆盖')
  return {
    entries: parsed.filter(row => row !== null && typeof row === 'object' && !Array.isArray(row)),
    raw,
    exists: true,
  }
}

/** 本地时间的备份文件名戳：`20250102-150405`。 */
function timestampStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 备份文件的时序键：`[时间戳, 同秒序号]`。
 * 字典序在这里不等于时间序——同秒的 base 文件（时间上最旧）按字典序排在所有
 * `-N` 后缀之后（`-` 0x2D < `.` 0x2E），且 `-10` 排在 `-2` 之前，所以淘汰
 * 必须按解析出的时间戳 + 数字后缀排序。
 */
function backupOrder(name) {
  const match = /^models-(\d{8}-\d{6})(?:-(\d+))?\.json$/.exec(name)
  return match === null ? ['', 0] : [match[1], Number(match[2] ?? 0)]
}

/** 把原文写入带时间戳的备份文件，同秒冲突追加 `-N` 后缀；随后淘汰超额旧备份。 */
function writeBackup(raw, paths) {
  fs.mkdirSync(paths.backups, { recursive: true, mode: 0o700 })
  const stamp = timestampStamp()
  let name = `models-${stamp}.json`
  let index = 0
  while (fs.existsSync(path.join(paths.backups, name))) {
    index += 1
    name = `models-${stamp}-${index}.json`
  }
  fs.writeFileSync(path.join(paths.backups, name), raw, { encoding: 'utf8', mode: 0o600 })
  const names = fs.readdirSync(paths.backups).filter(candidate => BACKUP_NAME.test(candidate))
    .sort((left, right) => {
      const [stampLeft, seqLeft] = backupOrder(left)
      const [stampRight, seqRight] = backupOrder(right)
      return stampLeft === stampRight ? seqLeft - seqRight : (stampLeft < stampRight ? -1 : 1)
    })
  for (const stale of names.slice(0, Math.max(0, names.length - BACKUP_KEEP))) {
    try { fs.rmSync(path.join(paths.backups, stale), { force: true }) } catch { /* 下次提交再淘汰 */ }
  }
}

/**
 * 统一提交管线（次序固定）：
 * 1. 组装内容写 tmp（0o600）；tmp 失败 → 直接中止，无备份、无变更；
 * 2. tmp 成功后把原文备份（首次写入没有原文，跳过）并淘汰超额旧备份；
 * 3. rename 原子替换；rename 失败则原文仍在、备份已留存，重试即可。
 */
async function commit(entries, previousRaw, paths) {
  const tmp = `${paths.file}.tmp-ofm`
  fs.mkdirSync(paths.dir, { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    if (previousRaw !== null) writeBackup(previousRaw, paths)
    fs.renameSync(tmp, paths.file)
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* tmp 残留无害 */ }
    throw error
  }
  return entries.length
}

/** 条目深比较用：同一模块生成的对象键序稳定，序列化比较即语义比较。 */
const sameEntry = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/**
 * 全量同步：幂等 upsert 启用且可解析的模型组，刷新归属单模型条目，
 * 清理 `combo:` 前缀的残留条目。无变更时短路返回，不产生备份。
 *
 * @returns {Promise<{added: number, updated: number, removed: number, total: number}>}
 */
export async function syncWorkbuddyModels({ combos, catalog, baseUrl, forwardKey, homeDir, dirName } = {}) {
  const paths = homePaths(homeDir, dirName)
  const state = readModelsFile(paths)
  const desired = buildWorkbuddyEntries({ combos, catalog, baseUrl, forwardKey })
  const desiredById = new Map(desired.map(entry => [entry.id, entry]))
  // 刷新来源只认真实模型行；组合行自身（channel: 'combo'）不参与。
  const realModelById = new Map(catalog.filter(row => !isComboEntry(row)).map(row => [row.id, row]))
  const next = []
  let added = 0
  let updated = 0
  let removed = 0
  for (const entry of state.entries) {
    const id = typeof entry?.id === 'string' ? entry.id : ''
    const target = id === '' ? undefined : desiredById.get(id)
    if (target !== undefined) {
      // upsert 以服务端为准覆盖（含同 id 的用户手改条目；备份可回滚找回）。
      if (!sameEntry(entry, target)) updated += 1
      next.push(target)
      continue
    }
    if (isOwnedByOfm(entry) && id.startsWith(COMBO_PREFIX)) {
      // 清理范围仅限 combo: 前缀的归属条目：已删除/停用/成员全不可用的组。
      removed += 1
      continue
    }
    const model = isOwnedByOfm(entry) && !id.startsWith(COMBO_PREFIX) ? realModelById.get(id) : undefined
    if (model !== undefined) {
      // 归属单模型条目：刷新 url/apiKey/能力字段；目录里已不存在的保留不动。
      const fresh = buildWorkbuddyEntryFromModel(model, { baseUrl, forwardKey })
      if (sameEntry(entry, fresh)) next.push(entry)
      else { updated += 1; next.push(fresh) }
      continue
    }
    next.push(entry)
  }
  const present = new Set(next.map(entry => (typeof entry?.id === 'string' ? entry.id : '')))
  for (const entry of desired) {
    if (!present.has(entry.id)) { next.push(entry); added += 1 }
  }
  if (added === 0 && updated === 0 && removed === 0) {
    return { added, updated, removed, total: next.length }
  }
  const total = await commit(next, state.raw, paths)
  return { added, updated, removed, total }
}

/**
 * 单模型 upsert：只写这一个条目，不清理、不刷新其他条目。幂等——
 * 内容无变更时短路返回，不产生备份。
 *
 * @returns {Promise<{added: number, updated: number, total: number}>}
 */
export async function writeWorkbuddyModel({ model, baseUrl, forwardKey, homeDir, dirName } = {}) {
  const paths = homePaths(homeDir, dirName)
  const state = readModelsFile(paths)
  const entry = buildWorkbuddyEntryFromModel(model, { baseUrl, forwardKey })
  const index = state.entries.findIndex(row => row?.id === entry.id)
  let added = 0
  let updated = 0
  let next
  if (index >= 0) {
    if (sameEntry(state.entries[index], entry)) return { added: 0, updated: 0, total: state.entries.length }
    next = [...state.entries]
    next[index] = entry
    updated = 1
  } else {
    next = [...state.entries, entry]
    added = 1
  }
  const total = await commit(next, state.raw, paths)
  return { added, updated, total }
}

/**
 * 备份列表：仅接受本模块命名规范的文件（天然防路径穿越），按时间倒序。
 * 解析失败的备份 `entries: null`，前端据此禁用恢复按钮，但不阻断列表展示。
 *
 * @returns {Promise<Array<{file: string, at: number, bytes: number, entries: number | null}>>}
 */
export async function listWorkbuddyBackups({ homeDir } = {}) {
  const paths = homePaths(homeDir)
  let names
  try {
    names = fs.readdirSync(paths.backups)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw syncError(500, `无法读取 WorkBuddy 备份目录：${error?.message ?? error}`)
  }
  const backups = []
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue
    let stat
    try { stat = fs.statSync(path.join(paths.backups, name)) } catch { /* 竞态删除，跳过 */ }
    let entries = null
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(paths.backups, name), 'utf8'))
      if (Array.isArray(parsed)) entries = parsed.length
    } catch { /* 保留展示，恢复按钮由 entries === null 禁用 */ }
    backups.push({ file: name, at: stat.mtimeMs, bytes: stat.size, entries })
  }
  return backups.sort((left, right) => right.at - left.at)
}

/**
 * 回滚：整文件替换为备份内容。当前 models.json 会先走备份管线，
 * 因此回滚本身也可被再次回滚。文件名强校验，无路径穿越面。
 *
 * @returns {Promise<{restored: boolean, total: number, at: number}>}
 */
export async function restoreWorkbuddyBackup(file, { homeDir } = {}) {
  if (typeof file !== 'string' || !BACKUP_NAME.test(file)) throw syncError(400, '备份文件名不合法')
  const paths = homePaths(homeDir)
  const target = path.join(paths.backups, file)
  let raw
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch (error) {
    throw syncError(404, `无法读取备份文件：${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw syncError(400, `备份文件不是有效 JSON，无法恢复：${error?.message ?? error}`)
  }
  if (!Array.isArray(parsed)) throw syncError(400, '备份文件顶层必须是数组，无法恢复')
  let previousRaw = null
  try {
    previousRaw = fs.readFileSync(paths.file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw syncError(500, `无法读取当前 WorkBuddy 配置：${error?.message ?? error}`)
  }
  // 整文件替换：用户选择了某个历史快照，就完整还原它，不做归属过滤。
  const total = await commit(parsed, previousRaw, paths)
  const at = fs.statSync(target).mtimeMs
  return { restored: true, total, at }
}
