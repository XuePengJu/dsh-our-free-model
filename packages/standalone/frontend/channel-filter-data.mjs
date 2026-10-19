/** 渠道列表的多维筛选（状态 + 搜索 + 地区 + 积分方式）。
 *
 *  这里只放纯函数：组件的可见性判定、分类计数与分面计数全部委托到本模块，
 *  于是 `scripts/standalone-channel-filter-test.mjs` 可以直接 import 做行为断言，
 *  不再需要从 .tsx 源码里抠代码片段求值。
 *
 *  `state` 形状：{ statuses, search = '', filter = 'all', region = 'all', creditModes = [] }
 *  - statuses 为 undefined 表示状态还没读到（此时数量显示占位符，而不是虚构的 0）；
 *  - region 单选取值 'all' | 'cn' | 'global'；
 *  - creditModes 多选取值 'daily' | 'onboarding' | 'quota'，空数组表示不限。
 */

/** 地区维度（单选）。顺序即面板里的展示顺序。 */
export const REGIONS = [
  { id: 'all', label: '全部' },
  { id: 'cn', label: '国内' },
  { id: 'global', label: '国外' },
]

/** 积分方式维度（可多选）。一个渠道可以同时属于多档（如 Loomy 既每日送也注册送）。 */
export const CREDIT_MODES = [
  { id: 'daily', label: '每日' },
  { id: 'onboarding', label: '一次性' },
  { id: 'quota', label: '额度' },
]

/** region 取值到中文标签的映射（详情头副标题用）。 */
export const REGION_LABELS = { cn: '国内', global: '国外' }

/** creditModes 取值到中文标签的映射（渠道行副标题用）。 */
export const CREDIT_LABELS = { daily: '每日', onboarding: '一次性', quota: '额度' }

/** 单条渠道是否已接入：有启用账号且未被禁用。 */
function isConnected(status) {
  return (status?.accounts?.enabled ?? 0) > 0 && !status?.closed
}

/** 把调用方传入的 state 归一化成带默认值的完整形状，避免各处重复写 `?? 默认值`。 */
function normalize(state) {
  return {
    statuses: state?.statuses,
    search: state?.search ?? '',
    filter: state?.filter ?? 'all',
    region: state?.region ?? 'all',
    creditModes: Array.isArray(state?.creditModes) ? state.creditModes : [],
  }
}

/**
 * 单一判定：渠道行是否命中当前筛选条件。
 *
 * 四个维度之间是 AND，维度内部（creditModes）是 OR —— 选了「每日 + 一次性」
 * 表示两者都要，而不是两者交集。
 *
 * @param {{ id: string, name?: string, org?: string, region?: string, creditModes?: string[] }} provider
 * @param {{ statuses?: Record<string, any>, search?: string, filter?: string, region?: string, creditModes?: string[] }} state
 * @returns {boolean}
 */
export function matchesChannel(provider, state) {
  const { statuses, search, filter, region, creditModes } = normalize(state)
  const status = statuses?.[provider.id]
  const connectedRow = isConnected(status)
  return `${provider.name} ${provider.org}`.toLowerCase().includes(search.toLowerCase().trim())
    && (filter === 'all' || (status !== undefined && (filter === 'connected' ? connectedRow : !connectedRow)))
    && (region === 'all' || provider.region === region)
    && (creditModes.length === 0 || (provider.creditModes ?? []).some(mode => creditModes.includes(mode)))
}

/**
 * 计算列表视图：命中的行、状态分类计数、分面计数与账号总数。
 *
 * `counts` 恒为全量统计，不随任何筛选变化（保持渠道 chips 的既有语义）；
 * `facets` 则是「忽略自身维度」后算出来的，所以面板里的数字永远告诉用户
 * 「再选这一档还剩多少」，而不是点了之后才发现是 0。
 *
 * @param {Array<{ id: string, region?: string, creditModes?: string[] }>} providers
 * @param {{ statuses?: Record<string, any>, search?: string, filter?: string, region?: string, creditModes?: string[] }} state
 * @returns {{ rows: any[], counts: { all: number, connected: number, pending: number },
 *   facets: { regions: Record<string, number>, credits: Record<string, number> },
 *   accounts: number, connected: number }}
 */
export function filterChannels(providers, state) {
  const list = Array.isArray(providers) ? providers : []
  const settings = normalize(state)
  const rows = list.filter(provider => matchesChannel(provider, settings))
  const connected = list.filter(provider => isConnected(settings.statuses?.[provider.id])).length
  // 待接入 = 状态已读到、但没有可用账号（含被禁用）。未读取的渠道不算待接入。
  const pending = list.filter(provider => {
    const status = settings.statuses?.[provider.id]
    return status !== undefined && !isConnected(status)
  }).length
  const accounts = Object.values(settings.statuses ?? {}).reduce((sum, row) => sum + (row?.accounts?.total ?? 0), 0)
  return {
    rows,
    counts: { all: list.length, connected, pending },
    facets: {
      regions: regionFacets(list, settings),
      credits: creditFacets(list, settings),
    },
    accounts,
    connected,
  }
}

/** 地区分面：应用 search + filter + creditModes，忽略 region 自身。 */
function regionFacets(list, settings) {
  const base = list.filter(provider => matchesChannel(provider, { ...settings, region: 'all' }))
  const regions = { all: base.length, cn: 0, global: 0 }
  for (const provider of base) {
    if (provider.region === 'cn' || provider.region === 'global') regions[provider.region] += 1
  }
  return regions
}

/** 积分方式分面：应用 search + filter + region，忽略 creditModes 自身（一个渠道可被多档同时计数）。 */
function creditFacets(list, settings) {
  const base = list.filter(provider => matchesChannel(provider, { ...settings, creditModes: [] }))
  const credits = { all: base.length, daily: 0, onboarding: 0, quota: 0 }
  for (const provider of base) {
    const modes = Array.isArray(provider.creditModes) ? provider.creditModes : []
    for (const mode of ['daily', 'onboarding', 'quota']) {
      if (modes.includes(mode)) credits[mode] += 1
    }
  }
  return credits
}

/**
 * 数量文案：状态没读到之前显示破折号，不显示 0（0 会被读成「这个分类是空的」）。
 *
 * @param {number} count
 * @param {Record<string, any> | undefined} statuses
 * @returns {string}
 */
export function countLabel(count, statuses) {
  return statuses === undefined ? '—' : String(count)
}

/**
 * 已启用的额外筛选条件数量（地区算 1，每个积分方式算 1），用于触发器上的角标。
 *
 * @param {{ region?: string, creditModes?: string[] }} state
 * @returns {number}
 */
export function activeFilterCount(state) {
  const region = state?.region ?? 'all'
  const creditModes = Array.isArray(state?.creditModes) ? state.creditModes : []
  return (region === 'all' ? 0 : 1) + creditModes.length
}
