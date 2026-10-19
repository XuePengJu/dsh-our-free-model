import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  activeFilterCount, countLabel, filterChannels, matchesChannel,
} from '../packages/standalone/frontend/channel-filter-data.mjs'

const source = fs.readFileSync(new URL('../packages/standalone/frontend/components/channel-browser.tsx', import.meta.url), 'utf8')
const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// chips 的结构断言（不再求值源码片段）：三个状态 chips 必须保持 onClick/label/span 的形状，
// 计数文案由 countLabel 提供，这样「状态未读到时显示破折号」的语义不会在改版中丢掉。
assert.match(source, /onClick=\{\(\) => setFilter\(id\)\}>\{label\}<span>\{(.+?)\}<\/span>/, '状态 chips 必须保持 onClick/label/span 结构')

/** 四种状态的假渠道：已接入、待接入、已禁用、未读取。 */
const providers = [
  { id: 'connected', name: '已接入渠道', org: '测试', region: 'cn', creditModes: ['daily'] },
  { id: 'pending', name: '待接入渠道', org: '测试', region: 'cn', creditModes: ['onboarding'] },
  { id: 'closed', name: '关闭渠道', org: '测试', region: 'global', creditModes: ['quota'] },
  { id: 'unknown', name: '未读取渠道', org: '测试', region: 'global', creditModes: ['quota'] },
]
const statuses = {
  connected: { accounts: { total: 1, enabled: 1 } },
  pending: { accounts: { total: 1, enabled: 0 } },
  closed: { closed: true, accounts: { total: 1, enabled: 1 } },
}

/** 多维组合用的 4 条渠道：地区与积分方式交叉，其中一条双属。 */
const multi = [
  { id: 'cn-daily', name: '国内每日', org: '测试', region: 'cn', creditModes: ['daily'] },
  { id: 'cn-onboarding', name: '国内一次性', org: '测试', region: 'cn', creditModes: ['onboarding'] },
  { id: 'cn-both', name: '国内双属', org: '测试', region: 'cn', creditModes: ['daily', 'onboarding'] },
  { id: 'global-quota', name: '国外额度', org: '测试', region: 'global', creditModes: ['quota'] },
]

export function verifyChannelFilters() {
  // ---- 旧语义：分类计数恒为全量，不随任何筛选变化 ----
  for (const [filter, expectedRows] of [['all', 4], ['connected', 1], ['pending', 2]]) {
    const view = filterChannels(providers, { statuses, filter })
    assert.deepEqual(view.counts, { all: 4, connected: 1, pending: 2 }, '分类数量不得随选中的筛选项变化')
    assert.equal(view.rows.length, expectedRows)
  }
  const searched = filterChannels(providers, { statuses, filter: 'pending', search: '关闭' })
  assert.equal(searched.rows.length, 1)
  assert.equal(searched.rows[0].id, 'closed')
  assert.deepEqual(searched.counts, { all: 4, connected: 1, pending: 2 }, '分类标签显示全量统计，搜索结果数由结果栏展示')
  assert.deepEqual(filterChannels(providers, { statuses: {} }).counts, { all: 4, connected: 0, pending: 0 },
    '未读取的渠道不能计入待接入')
  // 状态加载前不显示虚构的分类数量（0 会被读成「这个分类是空的」）。
  const loading = filterChannels(providers, { statuses: undefined })
  assert.equal(countLabel(loading.counts.all, undefined), '—')
  assert.equal(loading.counts.all, 4)
  assert.equal(countLabel(loading.counts.connected, undefined), '—')
  assert.equal(countLabel(loading.counts.all, {}), '4', '状态读完后显示真实数字')

  // ---- 1. 跨维度 AND 组合 ----
  // 注：`{region:'cn'}` 命中 3 条；再叠 daily 之后是 2 条（cn-daily 与 cn-both），
  // cn-onboarding 被 daily 排除 —— 这正是 AND 该有的收窄行为。
  assert.equal(filterChannels(multi, { region: 'cn' }).rows.length, 3, '国内单维度应命中 3 条')
  const cnDaily = filterChannels(multi, { region: 'cn', creditModes: ['daily'] })
  assert.equal(cnDaily.rows.length, 2, '国内 + 每日 应命中 2 条（双属那条也算）')
  assert.deepEqual(cnDaily.rows.map(row => row.id), ['cn-daily', 'cn-both'])
  const globalQuota = filterChannels(multi, { region: 'global', creditModes: ['quota'] })
  assert.equal(globalQuota.rows.length, 1, '国外 + 额度 应命中 1 条')
  assert.deepEqual(globalQuota.rows.map(row => row.id), ['global-quota'])

  // ---- 2. 维度内 OR：多选是并集 ----
  const dailyOnly = filterChannels(multi, { creditModes: ['daily'] }).rows.map(row => row.id)
  const bothModes = filterChannels(multi, { creditModes: ['daily', 'onboarding'] }).rows.map(row => row.id)
  assert.ok(dailyOnly.every(id => bothModes.includes(id)), '多选积分方式必须是并集，而不是交集')

  // ---- 3. Loomy 双属：每日与一次性都要命中 ----
  assert.equal(matchesChannel({ creditModes: ['daily', 'onboarding'] }, { creditModes: ['daily'] }), true)
  assert.equal(matchesChannel({ creditModes: ['daily', 'onboarding'] }, { creditModes: ['onboarding'] }), true)

  // ---- 4. Raccoon 只属一次性，不能落进每日 ----
  assert.equal(matchesChannel({ creditModes: ['onboarding'] }, { creditModes: ['daily'] }), false)
  assert.equal(matchesChannel({ creditModes: ['onboarding'] }, { creditModes: ['onboarding'] }), true)

  // ---- 5. 分面忽略自身维度：已选中的积分方式不影响积分方式的候选数字 ----
  const facetPlain = filterChannels(multi, { region: 'cn', creditModes: [] }).facets.credits
  const facetSelected = filterChannels(multi, { region: 'cn', creditModes: ['onboarding'] }).facets.credits
  assert.deepEqual(facetSelected, facetPlain, '积分方式分面必须忽略 creditModes 自身')
  const regionPlain = filterChannels(multi, { creditModes: ['daily'], region: 'all' }).facets.regions
  const regionSelected = filterChannels(multi, { creditModes: ['daily'], region: 'cn' }).facets.regions
  assert.deepEqual(regionSelected, regionPlain, '地区分面必须忽略 region 自身')

  // ---- 6. 跨维度清空护栏：单条判定与列表结果必须永远同结论 ----
  const combos = [
    { region: 'all', creditModes: [] },
    { region: 'cn', creditModes: [] },
    { region: 'global', creditModes: [] },
    { region: 'cn', creditModes: ['daily'] },
    { region: 'global', creditModes: ['quota'] },
    { region: 'cn', creditModes: ['daily', 'onboarding'] },
    { region: 'all', creditModes: ['onboarding'] },
  ]
  for (const combo of combos) {
    const view = filterChannels(providers, { statuses, ...combo })
    for (const provider of providers) {
      assert.equal(
        matchesChannel(provider, { statuses, ...combo }),
        view.rows.includes(provider),
        `matchesChannel 与 filterChannels 结论不一致：${provider.id} / ${JSON.stringify(combo)}`,
      )
    }
  }

  // ---- 7. 角标计数 ----
  assert.equal(activeFilterCount({ region: 'all', creditModes: [] }), 0)
  assert.equal(activeFilterCount({ region: 'cn', creditModes: [] }), 1)
  assert.equal(activeFilterCount({ region: 'cn', creditModes: ['daily', 'onboarding'] }), 3)

  // ---- 8. 14 条渠道字段齐全 ----
  const regionHits = (clientSource.match(/region: '(?:cn|global)'/g) ?? []).length
  const creditHits = (clientSource.match(/creditModes: \[/g) ?? []).length
  assert.equal(regionHits, 14, 'CHANNEL_PROVIDERS 每条都必须有 region')
  assert.equal(creditHits, 14, 'CHANNEL_PROVIDERS 每条都必须有 creditModes')

  // ---- 9. 分布：地区可求和，积分方式因双属而多 1 ----
  const regions = clientSource.match(/region: '(?:cn|global)'/g) ?? []
  const cn = regions.filter(hit => hit.includes("'cn'")).length
  const global = regions.filter(hit => hit.includes("'global'")).length
  assert.equal(cn, 10, '国内渠道应为 10 条')
  assert.equal(global, 4, '国外渠道应为 4 条')
  assert.equal(cn + global, 14)
  const modes = [...clientSource.matchAll(/creditModes: \[([^\]]*)\]/g)].map(([, body]) => body)
  const daily = modes.filter(body => body.includes("'daily'")).length
  const onboarding = modes.filter(body => body.includes("'onboarding'")).length
  const quota = modes.filter(body => body.includes("'quota'")).length
  assert.equal(daily, 10, '每日档应为 10 条')
  assert.equal(onboarding, 2, '一次性档应为 2 条')
  assert.equal(quota, 3, '额度档应为 3 条')
  // 15 ≠ 14 是预期的：Loomy 既每日送 5000 又注册送 5000+新手任务 10000，
  // 所以它在 daily 与 onboarding 两档里各计一次。断言写成 15，不要改成 14。
  assert.equal(daily + onboarding + quota, 15, '积分方式合计为 15（Loomy 双属，比渠道数多 1）')
}

// 顶层直接跑一次，让 `node scripts/test-all.mjs --only standalone-channel-filter` 真的断言行为，
// 而不是只 import 一个从不执行的函数。standalone-frontend-test.mjs 仍会再调用一次（纯函数，无副作用）。
verifyChannelFilters()
// 只有作为入口脚本运行时才打印，避免被 standalone-frontend-test.mjs import 时多刷一行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('standalone-channel-filter: 状态/搜索/地区/积分方式多维筛选与分面计数检查通过')
}
