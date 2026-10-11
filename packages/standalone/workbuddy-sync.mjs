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
const REASONING_EFFORTS = ['high', 'xhigh']

function homePaths(homeDir) {
  const root = path.join(homeDir ?? os.homedir(), '.workbuddy')
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
    const host = new URL(String(value)).hostname
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
 * 单个模型目录行 → WorkBuddy 条目。模型组（combo 虚拟行）与真实模型行共用：
 * combo 行的 vision/reasoning/contextWindow/maxOutput 已由 buildComboCatalog
 * 算好交集，字段形状与真实模型行一致。
 */
export function buildWorkbuddyEntryFromModel(model, { baseUrl, forwardKey }) {
  const supportsReasoning = model.reasoning === true ||
    (model.reasoning !== null && typeof model.reasoning === 'object')
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
    ...(supportsReasoning ? { reasoning: { supportedEfforts: [...REASONING_EFFORTS] } } : {}),
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
    throw new Error(`无法读取 WorkBuddy 配置（${paths.file}）：${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`WorkBuddy 配置（models.json）不是有效 JSON，已拒绝写入以避免覆盖：${error?.message ?? error}`)
  }
  if (!Array.isArray(parsed)) throw new Error('WorkBuddy 配置（models.json）顶层必须是数组，已拒绝写入以避免覆盖')
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
  const names = fs.readdirSync(paths.backups).filter(candidate => BACKUP_NAME.test(candidate)).sort()
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
export async function syncWorkbuddyModels({ combos, catalog, baseUrl, forwardKey, homeDir } = {}) {
  const paths = homePaths(homeDir)
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
export async function writeWorkbuddyModel({ model, baseUrl, forwardKey, homeDir } = {}) {
  const paths = homePaths(homeDir)
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
    throw new Error(`无法读取 WorkBuddy 备份目录：${error?.message ?? error}`)
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
  if (typeof file !== 'string' || !BACKUP_NAME.test(file)) throw new Error('备份文件名不合法')
  const paths = homePaths(homeDir)
  const target = path.join(paths.backups, file)
  let raw
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch (error) {
    throw new Error(`无法读取备份文件：${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`备份文件不是有效 JSON，无法恢复：${error?.message ?? error}`)
  }
  if (!Array.isArray(parsed)) throw new Error('备份文件顶层必须是数组，无法恢复')
  let previousRaw = null
  try {
    previousRaw = fs.readFileSync(paths.file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`无法读取当前 WorkBuddy 配置：${error?.message ?? error}`)
  }
  // 整文件替换：用户选择了某个历史快照，就完整还原它，不做归属过滤。
  const total = await commit(parsed, previousRaw, paths)
  const at = fs.statSync(target).mtimeMs
  return { restored: true, total, at }
}
