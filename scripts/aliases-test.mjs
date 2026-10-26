/**
 * Model aliases: the readable name a client types instead of `qodercn/qmodel_38max`.
 *
 * The failure this guards against is not "the alias looks wrong" but "the alias
 * quietly moved". A gateway that re-derives names from whatever is currently
 * visible will hand `qwen3.8-max` to a *different* channel the moment the first
 * one is disabled — every client configured with that name then talks to a model
 * nobody chose. The checks below pin the properties that prevent it: names are
 * assigned from the full catalog, a real id is never shadowed, and an alias never
 * carries a `/` (the channel dispatcher would read it as a provider prefix).
 *
 * Run: node scripts/aliases-test.mjs
 */
import assert from 'node:assert/strict'
import {
  ALIAS_MODE_DEFAULT, aliasFromName, aliasModelRow, buildAliasRows, normalizeAliasSettings, resolveModelAlias, suggestedAlias,
} from '../src/aliases.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const catalog = [
  { id: 'qodercn/qmodel_38max', name: 'Qwen3.8-Max · x0.5', channel: 'qodercn' },
  { id: 'qodercn/qfmodel', name: 'Qwen3.8-Flash · 免费', channel: 'qodercn' },
  { id: 'qodercn/gmodel', name: 'GLM-5.3 · x0.8', channel: 'qodercn' },
  { id: 'qoder/gmodel', name: 'GLM-5.3 · x1.2', channel: 'qoder' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', channel: 'anonymous' },
  { id: 'workbuddy/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', channel: 'workbuddy' },
  { id: 'workbuddy/deepseek-v4.1-flash-sg', name: 'DeepSeek V4.1 Flash', channel: 'workbuddy' },
  { id: 'combo:fast', name: 'Fast', channel: 'combo', combo: ['qodercn/qmodel_38max'] },
]
const rows = buildAliasRows(catalog)
const aliasOf = target => rows.find(row => row.target === target)?.alias

console.log('alias naming')

check('drops the price suffix and lowercases', () => {
  assert.equal(aliasFromName('Qwen3.8-Max · x0.5'), 'qwen3.8-max')
  assert.equal(aliasFromName('Qwen3.8-Flash · 免费'), 'qwen3.8-flash')
})

check('keeps dots, folds other separators into one dash', () => {
  assert.equal(aliasFromName('DeepSeek-V4.1-Pro  Preview'), 'deepseek-v4.1-pro-preview')
  assert.equal(aliasFromName('  GLM 5.3  '), 'glm-5.3')
})

check('a Chinese name keeps its characters', () => {
  assert.equal(aliasFromName('千问办公'), '千问办公')
})

check('every alias is slash-free', () => {
  for (const row of rows) assert.ok(!row.alias.includes('/'), `${row.alias} must not contain a slash`)
})

console.log('collisions')

check('a real id is never shadowed by an alias', () => {
  assert.equal(aliasOf('anonymous/deepseek-v4.1-flash'), undefined)
  // `deepseek-v4.1-flash` is a routable id, so the channel copy needs another name.
  assert.equal(aliasOf('workbuddy/deepseek-v4.1-flash'), 'deepseek-v4.1-flash-workbuddy')
})

check('the channel suffix disambiguates two channels with the same display name', () => {
  assert.equal(aliasOf('qodercn/gmodel'), 'glm-5.3')
  assert.equal(aliasOf('qoder/gmodel'), 'glm-5.3-qoder')
})

check('the id tail is used when the channel suffix is taken too', () => {
  assert.equal(aliasOf('workbuddy/deepseek-v4.1-flash-sg'), 'deepseek-v4.1-flash-sg')
})

check('an entry whose id is already its own slug gets no alias', () => {
  assert.equal(aliasOf('deepseek-v4.1-flash'), undefined)
  assert.equal(suggestedAlias({ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }), 'deepseek-v4.1-flash')
})

check('combo rows are not aliased', () => {
  assert.ok(!rows.some(row => row.target.startsWith('combo:')))
})

console.log('assignment stability')

check('a disabled model keeps its name, it is not handed to a neighbour', () => {
  // Disabling is not this module's input: the caller always passes the full
  // catalog, so the assignment cannot depend on what happens to be enabled.
  const before = aliasOf('qodercn/gmodel')
  const after = buildAliasRows(catalog, { overrides: { 'qodercn/gmodel': { enabled: false } } })
  assert.equal(before, 'glm-5.3')
  assert.equal(after.find(row => row.target === 'qoder/gmodel')?.alias, 'glm-5.3-qoder')
  assert.equal(after.some(row => row.target === 'qodercn/gmodel'), false)
})

console.log('overrides')

check('a rename wins over the generated name', () => {
  const renamed = buildAliasRows(catalog, { overrides: { 'qodercn/qmodel_38max': { alias: 'Qwen 3.8 Max' } } })
  assert.equal(renamed.find(row => row.target === 'qodercn/qmodel_38max').alias, 'qwen-3.8-max')
})

check('a switch-off removes only that row', () => {
  const off = buildAliasRows(catalog, { overrides: { 'qodercn/qmodel_38max': { enabled: false } } })
  assert.equal(off.some(row => row.target === 'qodercn/qmodel_38max'), false)
  assert.equal(off.find(row => row.target === 'qodercn/qfmodel').alias, 'qwen3.8-flash')
})

check('an unknown mode falls back to the default, an explicit one is honoured', () => {
  assert.equal(normalizeAliasSettings({ mode: 'nonsense' }).mode, ALIAS_MODE_DEFAULT)
  assert.equal(normalizeAliasSettings(undefined).mode, ALIAS_MODE_DEFAULT)
  assert.equal(normalizeAliasSettings({ mode: 'alias' }).mode, 'alias')
  assert.equal(normalizeAliasSettings({ mode: 'both' }).mode, 'both')
  assert.equal(normalizeAliasSettings({ mode: 'id' }).mode, 'id')
})

check('an override with an unusable alias keeps its switch-off', () => {
  const settings = normalizeAliasSettings({ overrides: { 'a/b': { alias: '   ', enabled: false } } })
  assert.deepEqual(settings.overrides['a/b'], { enabled: false })
})

console.log('resolution')

check('a known alias resolves to its target', () => {
  assert.equal(resolveModelAlias('qwen3.8-max', rows), 'qodercn/qmodel_38max')
})

check('matching ignores case', () => {
  assert.equal(resolveModelAlias('Qwen3.8-Max', rows), 'qodercn/qmodel_38max')
})

check('an unknown name passes through untouched', () => {
  assert.equal(resolveModelAlias('qodercn/not-a-model', rows), 'qodercn/not-a-model')
  assert.equal(resolveModelAlias('totally-made-up', rows), 'totally-made-up')
})

check('a real id still resolves to itself', () => {
  assert.equal(resolveModelAlias('qodercn/qmodel_38max', rows), 'qodercn/qmodel_38max')
})

check('empty input stays empty', () => {
  assert.equal(resolveModelAlias('', rows), '')
  assert.equal(resolveModelAlias(undefined, rows), '')
})

console.log('advertisement')

// 这条钉的是一个真实踩过的坑：别名行如果继承原始显示名，任何按 `name` 建索引的
// 客户端（「添加模型」弹窗就是这么干的）都会把它当重复项丢掉，用户于是只看得到
// `qodercn/qmodel_38max`，却看不到我们已经给他起好的 `qwen3.8-max`。
check('an alias row is advertised under its own name, not the target display name', () => {
  const target = { id: 'qodercn/qmodel_38max', name: 'Qwen3.8-Max · x0.5', channel: 'qodercn' }
  const row = aliasModelRow(target, 'qwen3.8-max')
  assert.equal(row.id, 'qwen3.8-max')
  assert.equal(row.name, 'qwen3.8-max')
  assert.equal(row.x_ofm_alias_of, 'qodercn/qmodel_38max')
  assert.equal(row.channel, 'qodercn')
})

check('no two advertised rows share a display name', () => {
  const catalog = [
    { id: 'qodercn/qmodel_38max', name: 'Qwen3.8-Max · x0.5', channel: 'qodercn' },
    { id: 'other/qmodel_38max', name: 'Qwen3.8-Max · x0.5', channel: 'other' },
    { id: 'workbuddy/glm-5.3-flash', name: 'GLM-5.3-Flash · x0.08', channel: 'workbuddy' },
    { id: 'trae/glm-5.3-flash', name: 'GLM-5.3-Flash · x0.08', channel: 'trae' },
    { id: 'already-readable', name: 'Already Readable', channel: 'anonymous' },
  ]
  const advertised = buildAliasRows(catalog, { mode: 'alias' })
    .map(row => aliasModelRow(catalog.find(entry => entry.id === row.target), row.alias))
  const names = [...advertised.map(row => row.name), 'Already Readable']
  assert.equal(new Set(names).size, names.length, `同名行会被客户端去重吞掉: ${names.join(', ')}`)
})

check('a Chinese display name keeps its real id instead of minting a Chinese id', () => {
  const rows = buildAliasRows([{ id: 'nvidia/nemotron:free', name: '测试免费模型', channel: 'nvidia' }])
  assert.deepEqual(rows, [])
})

console.log(failures === 0 ? '\naliases: every name is readable, stable and routable' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
