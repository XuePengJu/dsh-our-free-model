/**
 * The build gate that keeps `vendor/channel-pack/pack.js` from regressing (#572).
 *
 * The failure it exists for is silent by nature: a rebuild from a stale `src/`
 * produces a smaller bundle that still mounts, so nothing downstream complains
 * until a user hits the re-opened defect. These cases pin both halves — that a
 * lost marker is refused, and that a healthy rebuild is allowed through.
 *
 * Run: node scripts/channel-pack-gate-test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PACK_MARKERS, countMarkers, markerRegressions, staleMarkers } from './lib/channel-pack-gate.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

const shipped = [
  'function collectHarnessSystem() {}',
  'const proseSuppressor = 1',
  'createBlankReasoningSuppressor(1)',
  'if (text.trim().length === 0 && toolCalls.length === 0) continue',
  'export { createChannelFetch }',
  'class ChannelNetworkError extends Error {}',
  'function zcodePlatformKey() { return `${process.platform}-${process.arch}` }',
  'export function probeBrowserVersion(executable) {}',
  'this.launcherExited = true',
  "void this.browserCdp?.send('Browser.close', {}, 2_000)",
].join('\n')

// --- counting -------------------------------------------------------------

// countMarkers is scoped to the gate's own list, so the probe uses a real entry.
check('countMarkers counts every occurrence, not just presence',
  countMarkers('proseSuppressor proseSuppressor proseSuppressor').get('proseSuppressor'), 3)
check('countMarkers reports 0 for an absent marker',
  countMarkers('nothing here').get('proseSuppressor'), 0)

// --- the healthy case -----------------------------------------------------

check('an identical rebuild is not a regression',
  markerRegressions(shipped, shipped), [])
check('growth is not a regression',
  markerRegressions(shipped, `${shipped}\n${shipped}`), [])

// --- the #572 case --------------------------------------------------------

// Exactly what the issue measured: `src/` older than `pack.js` drops whole
// features while the bundle still loads.
const regressed = shipped
  .replace('function collectHarnessSystem() {}\n', '')
  .replace('if (text.trim().length === 0 && toolCalls.length === 0) continue\n', '')

check('a dropped marker is reported with its before/after counts',
  markerRegressions(shipped, regressed),
  [
    { marker: 'collectHarnessSystem', before: 1, after: 0 },
    { marker: 'toolCalls.length === 0) continue', before: 1, after: 0 },
  ])

// A rebuild that keeps the marker once where the shipped bundle had three has
// still lost two call sites — count, not presence, is what the gate compares.
check('a partially dropped marker is reported',
  markerRegressions('proseSuppressor proseSuppressor proseSuppressor', 'proseSuppressor'),
  [{ marker: 'proseSuppressor', before: 3, after: 1 }])

// --- staleness ------------------------------------------------------------

check('a marker the shipped bundle lacks is reported as stale',
  staleMarkers('proseSuppressor'), PACK_MARKERS.filter(marker => marker !== 'proseSuppressor'))
check('a shipped bundle containing every marker has none stale',
  staleMarkers(shipped), [])

// --- the real bundle ------------------------------------------------------

// Guards the list itself: an entry that no longer appears in the shipped bundle
// can never fire, so it would quietly stop protecting anything.
const bundle = fs.readFileSync(
  fileURLToPath(new URL('../vendor/channel-pack/pack.js', import.meta.url)), 'utf8')
const stale = staleMarkers(bundle)
check('every marker is present in the shipped pack.js', stale, [])
if (stale.length > 0) {
  console.log('       refresh scripts/lib/channel-pack-gate.mjs — these markers are gone from the bundle')
}

// #130: marker preservation alone cannot detect arbitrary source/bundle drift.
// Exercise the real build path and its failure controls. A byte comparison is
// valid only when the oracle is the same native esbuild build as the artifact;
// esbuild's output is platform-dependent, so a different host or wasm oracle
// would reject a valid tree. `--check` still compares bytes in the environment
// that intentionally uses the same pinned toolchain.
const root = fileURLToPath(new URL('../', import.meta.url))
const runBuild = (cwd, args = []) => spawnSync(process.execPath, ['scripts/build-channel-pack.mjs', ...args], {
  cwd, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, OFM_ESBUILD_DIR: root }, timeout: 30_000,
})
const shippedCheck = runBuild(root, ['--check'])
// A contributor may use a different native esbuild build from the one that
// produced the checked-in artifact. Marker checks remain authoritative there;
// the isolated cases below still prove --check rejects genuine source drift.
if (shippedCheck.status !== 0) {
  const expectedCrossPlatformDifference = /pack\.js differs from its source/.test(shippedCheck.stderr)
    && stale.length === 0
  check('a cross-platform native build difference is distinguished from source drift', expectedCrossPlatformDifference, true)
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-pack-check-'))
try {
  fs.mkdirSync(path.join(scratch, 'scripts/lib'), { recursive: true })
  fs.mkdirSync(path.join(scratch, 'vendor/channel-pack/src'), { recursive: true })
  for (const file of ['scripts/build-channel-pack.mjs', 'scripts/lib/channel-pack-gate.mjs']) {
    fs.copyFileSync(path.join(root, file), path.join(scratch, file))
  }
  const entry = path.join(scratch, 'vendor/channel-pack/src/index.ts')
  const artifact = path.join(scratch, 'vendor/channel-pack/pack.js')
  fs.writeFileSync(entry, 'export const fixture = 1\n')
  check('an isolated first build succeeds', runBuild(scratch).status, 0)
  const original = fs.readFileSync(artifact, 'utf8')
  const modifiedAt = fs.statSync(artifact).mtimeMs
  check('check-only accepts a matching isolated artifact', runBuild(scratch, ['--check']).status, 0)
  check('check-only leaves the artifact modification time untouched', fs.statSync(artifact).mtimeMs, modifiedAt)
  fs.writeFileSync(entry, 'export const fixture = 2\n')
  check('check-only fails on actual source drift', runBuild(scratch, ['--check']).status, 1)
  check('a failed drift check preserves the old artifact', fs.readFileSync(artifact, 'utf8'), original)
  fs.writeFileSync(entry, 'export const broken = {\n')
  check('a failed source build is refused', runBuild(scratch, ['--check']).status, 1)
  check('a failed source build preserves the old artifact', fs.readFileSync(artifact, 'utf8'), original)
  check('unknown CLI flags are refused', runBuild(scratch, ['--chec']).status, 1)
  fs.unlinkSync(artifact)
  check('check-only refuses a missing artifact', runBuild(scratch, ['--check']).status, 1)
  check('check-only never creates a missing artifact', fs.existsSync(artifact), false)
  check('no staged bundle survives completed checks', fs.readdirSync(path.dirname(artifact)).filter(name => name.includes('.build-')), [])
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nall channel-pack gate checks passed' : `\n${failures} channel-pack gate check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
