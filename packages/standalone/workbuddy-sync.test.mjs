/**
 * Offline suite for the WorkBuddy sync module.
 *
 * Covers the contract that matters and is easy to get subtly wrong:
 *
 * - field mapping for combo rows (intersection via buildComboCatalog) and for
 *   single model rows (defaults at 131072/32768, conditional `reasoning`);
 * - ownership (`isOwnedByOfm`) and the "refresh but never clean single-model
 *   entries" rule — cleanup only ever touches `combo:` prefixed owned entries;
 * - the commit pipeline: no backup on first write, backup of the previous raw
 *   text afterwards, idempotent short-circuit without a new backup, and the
 *   20-backup retention window;
 * - read tolerance: invalid JSON / non-array top level must refuse to write;
 * - restore: strict filename check, whole-file replacement, and the fact that
 *   a restore is itself backed up (rollback of a rollback works).
 *
 * Every case runs against a throwaway temp home directory — the real
 * `~/.workbuddy/models.json` is never touched.
 *
 * Run: node packages/standalone/workbuddy-sync.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildWorkbuddyEntries,
  buildWorkbuddyEntryFromModel,
  isOwnedByOfm,
  listWorkbuddyBackups,
  restoreWorkbuddyBackup,
  syncWorkbuddyModels,
  writeWorkbuddyModel,
} from './workbuddy-sync.mjs'

const BASE_URL = 'http://127.0.0.1:18900'
const FORWARD_KEY = 'ofm-test-key-0001'
const LOOPBACK_URL = `${BASE_URL}/v1`

const tests = []
const test = (name, fn) => tests.push([name, fn])

/** A fresh throwaway home directory per case; cleaned up on process exit. */
const tempHomes = []
const newHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-workbuddy-'))
  tempHomes.push(home)
  return home
}
process.on('exit', () => {
  for (const home of tempHomes) {
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

const modelsFile = home => path.join(home, '.workbuddy', 'models.json')
const writeModels = (home, value) => {
  fs.mkdirSync(path.dirname(modelsFile(home)), { recursive: true })
  fs.writeFileSync(modelsFile(home), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
}
const readModels = home => JSON.parse(fs.readFileSync(modelsFile(home), 'utf8'))

const realModel = id => ({
  id, name: `模型 ${id}`, channel: 'anonymous',
  vision: id === 'vision-model', reasoning: id === 'think-model',
  contextWindow: 65536, maxOutput: 8192,
})
const catalogFor = (...ids) => ids.map(realModel)
const combosFor = (...models) => [{
  id: 'combo:chain', name: 'chain', models,
  strategy: 'fallback', stickyLimit: 1, enabled: true,
}]

// ---- 归属判定 ----

test('isOwnedByOfm: loopback + ofm- key is owned', () => {
  assert.equal(isOwnedByOfm({ id: 'deepseek', url: LOOPBACK_URL, apiKey: 'ofm-abc' }), true)
})

test('isOwnedByOfm: combo prefix is owned even without ofm- key (v1 compat)', () => {
  assert.equal(isOwnedByOfm({ id: 'combo:old', url: LOOPBACK_URL, apiKey: 'sk-manual' }), true)
})

test('isOwnedByOfm: non-loopback url is never owned', () => {
  assert.equal(isOwnedByOfm({ id: 'combo:old', url: 'https://api.example.com/v1', apiKey: 'ofm-abc' }), false)
  assert.equal(isOwnedByOfm({ id: 'x', url: LOOPBACK_URL.replace('127.0.0.1', '10.0.0.2'), apiKey: 'ofm-abc' }), false)
})

test('isOwnedByOfm: loopback + foreign key + no combo prefix is not owned', () => {
  assert.equal(isOwnedByOfm({ id: 'deepseek', url: LOOPBACK_URL, apiKey: 'sk-user-own' }), false)
})

test('isOwnedByOfm: malformed url / missing fields are not owned', () => {
  assert.equal(isOwnedByOfm({ id: 'x', url: 'not-a-url', apiKey: 'ofm-abc' }), false)
  assert.equal(isOwnedByOfm(undefined), false)
  assert.equal(isOwnedByOfm(null), false)
})

// ---- 字段映射 ----

test('buildWorkbuddyEntryFromModel: full mapping with defaults', () => {
  const entry = buildWorkbuddyEntryFromModel({
    id: 'plain', name: 'Plain', vision: false, reasoning: false,
  }, { baseUrl: BASE_URL, forwardKey: FORWARD_KEY })
  assert.deepEqual(entry, {
    id: 'plain', name: 'Plain', vendor: 'Custom', url: LOOPBACK_URL, apiKey: FORWARD_KEY,
    supportsToolCall: true, supportsImages: false, supportsReasoning: false, useCustomProtocol: false,
    maxInputTokens: 131072, maxOutputTokens: 32768,
  })
  assert.equal('reasoning' in entry, false)
})

test('buildWorkbuddyEntryFromModel: reasoning flag and efforts, snake_case fallbacks', () => {
  const entry = buildWorkbuddyEntryFromModel({
    id: 'think', name: 'Think', vision: true, reasoning: { supportedEfforts: ['low'] },
    context_window: 4096, max_tokens: 1024,
  }, { baseUrl: BASE_URL, forwardKey: FORWARD_KEY })
  assert.equal(entry.supportsReasoning, true)
  assert.deepEqual(entry.reasoning, { supportedEfforts: ['high', 'xhigh'] })
  assert.equal(entry.supportsImages, true)
  assert.equal(entry.maxInputTokens, 4096)
  assert.equal(entry.maxOutputTokens, 1024)
})

test('buildWorkbuddyEntries: enabled combos only, capacities are the intersection', () => {
  const entries = buildWorkbuddyEntries({
    combos: [
      { id: 'combo:chain', name: 'chain', models: ['a', 'vision-model'], strategy: 'fallback', stickyLimit: 1, enabled: true },
      { id: 'combo:off', name: 'off', models: ['a'], strategy: 'fallback', stickyLimit: 1, enabled: false },
    ],
    catalog: catalogFor('a', 'vision-model'),
    baseUrl: BASE_URL, forwardKey: FORWARD_KEY,
  })
  assert.equal(entries.length, 1)
  const [entry] = entries
  assert.equal(entry.id, 'combo:chain')
  assert.equal(entry.name, 'chain')
  assert.equal(entry.supportsImages, false) // a 不是视觉模型 → 交集为 false
  assert.equal(entry.maxInputTokens, 65536) // min(65536, 65536)
  assert.equal(entry.maxOutputTokens, 8192)
})

// ---- 全量同步 ----

test('syncWorkbuddyModels: first sync creates the file', async () => {
  const home = newHome()
  const result = await syncWorkbuddyModels({
    combos: combosFor('a', 'think-model'), catalog: catalogFor('a', 'think-model'),
    baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  assert.deepEqual(result, { added: 1, updated: 0, removed: 0, total: 1 })
  const entries = readModels(home)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'combo:chain')
})

test('syncWorkbuddyModels: second sync is a no-op with no new backup', async () => {
  const home = newHome()
  const options = {
    combos: combosFor('a', 'think-model'), catalog: catalogFor('a', 'think-model'),
    baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  }
  await syncWorkbuddyModels(options)
  await syncWorkbuddyModels(options)
  assert.deepEqual(await syncWorkbuddyModels(options), { added: 0, updated: 0, removed: 0, total: 1 })
  const backups = await listWorkbuddyBackups({ homeDir: home })
  assert.equal(backups.length, 0) // 无变更不备份
})

test('syncWorkbuddyModels: forwardKey rotation refreshes combo and owned single-model entries', async () => {
  const home = newHome()
  const catalog = catalogFor('a', 'think-model')
  const combos = combosFor('a', 'think-model')
  await syncWorkbuddyModels({ combos, catalog, baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home })
  // 用户逐个写入的单模型条目也应被顺带刷新。
  await writeWorkbuddyModel({
    model: realModel('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  const rotated = 'ofm-rotated-key'
  const result = await syncWorkbuddyModels({ combos, catalog, baseUrl: BASE_URL, forwardKey: rotated, homeDir: home })
  assert.deepEqual(result, { added: 0, updated: 2, removed: 0, total: 2 })
  for (const entry of readModels(home)) assert.equal(entry.apiKey, rotated)
})

test('syncWorkbuddyModels: deleted combo entry is cleaned, disabled combo too', async () => {
  const home = newHome()
  const catalog = catalogFor('a')
  await syncWorkbuddyModels({
    combos: [
      { id: 'combo:chain', name: 'chain', models: ['a'], strategy: 'fallback', stickyLimit: 1, enabled: true },
      { id: 'combo:off', name: 'off', models: ['a'], strategy: 'fallback', stickyLimit: 1, enabled: false },
    ],
    catalog, baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  // 停用组条目：成员目录仍在但组被停用 → buildComboCatalog 不产出 → 清理。
  const afterDisable = await syncWorkbuddyModels({
    combos: combosFor('a'), catalog, baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  assert.deepEqual(afterDisable, { added: 0, updated: 0, removed: 0, total: 1 })
  // combo:off 没有被写进来（停用），删掉 chain 后其条目应被清理。
  const result = await syncWorkbuddyModels({
    combos: [], catalog, baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  assert.deepEqual(result, { added: 0, updated: 0, removed: 1, total: 0 })
  assert.deepEqual(readModels(home), [])
})

test('syncWorkbuddyModels: single-model entries are refreshed but never cleaned', async () => {
  const home = newHome()
  await syncWorkbuddyModels({
    combos: combosFor('a'), catalog: catalogFor('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  await writeWorkbuddyModel({ model: realModel('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home })
  // 目录为空（模型下线）同步：combo 条目被清理，单模型条目保留不动。
  const result = await syncWorkbuddyModels({
    combos: [], catalog: [], baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  assert.deepEqual(result, { added: 0, updated: 0, removed: 1, total: 1 })
  const entries = readModels(home)
  assert.deepEqual(entries.map(entry => entry.id), ['a'])
})

test('syncWorkbuddyModels: foreign entries are never touched', async () => {
  const home = newHome()
  const foreign = { id: 'remote', name: 'Remote', vendor: 'Custom', url: 'https://api.example.com/v1', apiKey: 'sk-theirs' }
  const manual = { id: 'mine', name: 'Mine', vendor: 'Custom', url: LOOPBACK_URL, apiKey: 'sk-user-own' }
  writeModels(home, [foreign, manual])
  const result = await syncWorkbuddyModels({
    combos: combosFor('a'), catalog: catalogFor('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  assert.deepEqual(result, { added: 1, updated: 0, removed: 0, total: 3 })
  const entries = readModels(home)
  assert.deepEqual(entries.find(entry => entry.id === 'remote'), foreign)
  assert.deepEqual(entries.find(entry => entry.id === 'mine'), manual) // 回环+非 ofm key：不归属，不刷新不删除
})

test('syncWorkbuddyModels: invalid JSON refuses to write and preserves the file', async () => {
  const home = newHome()
  writeModels(home, '{ broken')
  await assert.rejects(
    () => syncWorkbuddyModels({
      combos: combosFor('a'), catalog: catalogFor('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
    }),
    /不是有效 JSON/,
  )
  assert.equal(fs.readFileSync(modelsFile(home), 'utf8'), '{ broken')
  assert.equal(fs.existsSync(`${modelsFile(home)}.tmp-ofm`), false)
})

test('syncWorkbuddyModels: non-array top level refuses to write', async () => {
  const home = newHome()
  writeModels(home, { entries: [] })
  await assert.rejects(
    () => syncWorkbuddyModels({
      combos: combosFor('a'), catalog: catalogFor('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
    }),
    /顶层必须是数组/,
  )
})

test('syncWorkbuddyModels: non-object array elements are filtered from the diff', async () => {
  const home = newHome()
  writeModels(home, [42, null, 'x'])
  const result = await syncWorkbuddyModels({
    combos: combosFor('a'), catalog: catalogFor('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  assert.deepEqual(result, { added: 1, updated: 0, removed: 0, total: 1 })
})

// ---- 单模型写入 ----

test('writeWorkbuddyModel: adds then updates in place, keeps everything else', async () => {
  const home = newHome()
  const other = { id: 'other', name: 'Other', vendor: 'Custom', url: 'https://api.example.com/v1', apiKey: 'sk-theirs' }
  writeModels(home, [other])
  const first = await writeWorkbuddyModel({
    model: realModel('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  assert.deepEqual(first, { added: 1, updated: 0, total: 2 })
  assert.deepEqual((await writeWorkbuddyModel({
    model: realModel('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })), { added: 0, updated: 0, total: 2 }) // 幂等：无变更短路
  const second = await writeWorkbuddyModel({
    model: realModel('a'), baseUrl: BASE_URL, forwardKey: 'ofm-rotated', homeDir: home,
  })
  assert.deepEqual(second, { added: 0, updated: 1, total: 2 })
  const entries = readModels(home)
  assert.deepEqual(entries.find(entry => entry.id === 'other'), other) // 不清理其他条目
  assert.equal(entries.find(entry => entry.id === 'a').apiKey, 'ofm-rotated')
})

// ---- 备份与回滚 ----

test('commit pipeline: first write has no backup, later writes back up the previous raw text', async () => {
  const home = newHome()
  const options = {
    model: realModel('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  }
  await writeWorkbuddyModel(options)
  assert.equal((await listWorkbuddyBackups({ homeDir: home })).length, 0)
  await writeWorkbuddyModel({ ...options, forwardKey: 'ofm-second' })
  const backups = await listWorkbuddyBackups({ homeDir: home })
  assert.equal(backups.length, 1)
  assert.match(backups[0].file, /^models-\d{8}-\d{6}\.json$/)
  assert.equal(backups[0].entries, 1)
  assert.equal(backups[0].bytes > 0, true)
  const raw = fs.readFileSync(path.join(home, '.workbuddy', 'models.json.backups', backups[0].file), 'utf8')
  assert.match(JSON.parse(raw).find(entry => entry.id === 'a').apiKey, /ofm-test-key|ofm-second/) // 原文备份
})

test('backup retention: only the newest 20 survive', async () => {
  const home = newHome()
  const options = {
    model: realModel('a'), baseUrl: BASE_URL, homeDir: home, forwardKey: FORWARD_KEY,
  }
  await writeWorkbuddyModel(options)
  for (let index = 0; index < 25; index += 1) {
    await writeWorkbuddyModel({ ...options, forwardKey: `ofm-rotation-${index}` })
  }
  const backups = await listWorkbuddyBackups({ homeDir: home })
  assert.equal(backups.length, 20)
  // 倒序：最新在前。
  for (let index = 1; index < backups.length; index += 1) {
    assert.equal(backups[index - 1].at >= backups[index].at, true)
  }
  // 保留的都是最后 20 次写入前的原文：最旧的备份 key 是 ofm-rotation-4。
  const oldest = JSON.parse(fs.readFileSync(
    path.join(home, '.workbuddy', 'models.json.backups', backups[backups.length - 1].file), 'utf8'))
  assert.equal(oldest.find(entry => entry.id === 'a').apiKey, 'ofm-rotation-4')
})

test('listWorkbuddyBackups: unparseable backup shows entries null; foreign files ignored', async () => {
  const home = newHome()
  fs.mkdirSync(path.join(home, '.workbuddy', 'models.json.backups'), { recursive: true })
  fs.writeFileSync(path.join(home, '.workbuddy', 'models.json.backups', 'models-20250101-000000.json'), '[{"id":"x"}]')
  fs.writeFileSync(path.join(home, '.workbuddy', 'models.json.backups', 'models-20250102-000000.json'), '{ broken')
  fs.writeFileSync(path.join(home, '.workbuddy', 'models.json.backups', 'README.txt'), 'ignore me')
  const backups = await listWorkbuddyBackups({ homeDir: home })
  assert.equal(backups.length, 2)
  assert.deepEqual(backups.map(backup => backup.entries), [null, 1]) // 时间倒序
})

test('restoreWorkbuddyBackup: rejects forged filenames and path traversal', async () => {
  const home = newHome()
  for (const file of ['../settings.json', 'models-2025-0101-000000.json', 'models-20250101-0000.json', '/etc/passwd', 42]) {
    await assert.rejects(() => restoreWorkbuddyBackup(file, { homeDir: home }), /备份文件名不合法/)
  }
})

test('restoreWorkbuddyBackup: whole-file replacement, current file backed up first', async () => {
  const home = newHome()
  const backupsDir = path.join(home, '.workbuddy', 'models.json.backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const snapshot = [{ id: 'combo:old', name: 'old', vendor: 'Custom', url: LOOPBACK_URL, apiKey: 'ofm-ancient' }]
  fs.writeFileSync(path.join(backupsDir, 'models-20250101-000000.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
  writeModels(home, [{ id: 'combo:current', name: 'current', vendor: 'Custom', url: LOOPBACK_URL, apiKey: 'ofm-current' }])

  const result = await restoreWorkbuddyBackup('models-20250101-000000.json', { homeDir: home })
  assert.equal(result.restored, true)
  assert.equal(result.total, 1)
  assert.equal(typeof result.at, 'number')
  assert.deepEqual(readModels(home), snapshot) // 完整还原，不做归属过滤
  // 回滚前的现场被备份：回滚本身可被再次回滚。
  const backups = await listWorkbuddyBackups({ homeDir: home })
  const evidence = backups.find(backup => backup.file !== 'models-20250101-000000.json')
  assert.notEqual(evidence, undefined)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(backupsDir, evidence.file), 'utf8'))
      .find(entry => entry.id === 'combo:current').apiKey,
    'ofm-current',
  )
})

test('restoreWorkbuddyBackup: corrupt or non-array backups are refused', async () => {
  const home = newHome()
  const backupsDir = path.join(home, '.workbuddy', 'models.json.backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  fs.writeFileSync(path.join(backupsDir, 'models-20250101-000001.json'), '{ broken')
  fs.writeFileSync(path.join(backupsDir, 'models-20250101-000002.json'), '{"nope": true}')
  await assert.rejects(
    () => restoreWorkbuddyBackup('models-20250101-000001.json', { homeDir: home }),
    /不是有效 JSON/,
  )
  await assert.rejects(
    () => restoreWorkbuddyBackup('models-20250101-000002.json', { homeDir: home }),
    /顶层必须是数组/,
  )
})

test('restoreWorkbuddyBackup: missing backup file errors clearly', async () => {
  const home = newHome()
  await assert.rejects(
    () => restoreWorkbuddyBackup('models-20250101-000009.json', { homeDir: home }),
    /无法读取备份文件/,
  )
})

// ---- 上下文：真实运行地址 / 端口自愈 ----

test('syncWorkbuddyModels: non-default port heals the url of owned entries', async () => {
  const home = newHome()
  writeModels(home, [{
    id: 'combo:chain', name: 'chain', vendor: 'Custom', url: 'http://127.0.0.1:40001/v1', apiKey: FORWARD_KEY,
  }])
  const result = await syncWorkbuddyModels({
    combos: combosFor('a'), catalog: catalogFor('a'), baseUrl: BASE_URL, forwardKey: FORWARD_KEY, homeDir: home,
  })
  assert.deepEqual(result, { added: 0, updated: 1, removed: 0, total: 1 })
  assert.equal(readModels(home)[0].url, LOOPBACK_URL)
})

let passed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`FAIL - ${name}`)
    throw error
  }
}

console.log(`\n${passed} checks passed`)
