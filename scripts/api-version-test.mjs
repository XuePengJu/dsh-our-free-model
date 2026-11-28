/**
 * Offline tests for the compact API-version ranges that decide whether a
 * third-party plugin can be installed into this host.
 *
 * `satisfiesApiVersion` is a small pure function with a large blast radius:
 * every branch either admits a plugin that may call host APIs, or rejects one
 * that was written for this host. A misread caret/tilde boundary turns into a
 * user seeing "incompatible plugin" for an extension that does work, or worse,
 * an extension built for a newer API being loaded into an older host. The
 * function had no direct test; the host-side gates that call it were covered,
 * but the range grammar itself was not.
 *
 * No network, no host instance, no credentials: this imports the range matcher
 * straight from src/plugins.js and pins the answers for every form authors
 * actually write (`^2`, `~2.1`, `2.x`, `2`, `>=2 <3`, `*`) plus the boundary
 * and malformed-input cases that must fail closed.
 *
 * Run: node scripts/api-version-test.mjs
 */
import assert from 'node:assert/strict'
import { satisfiesApiVersion } from '../src/plugins.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ── the two spellings of "anything" ──────────────────────────────────────────
check('an empty or wildcard range accepts any host', () => {
  for (const range of ['*', '**', '', '   ']) {
    assert.equal(satisfiesApiVersion(range, '2.5.0'), true, `range ${JSON.stringify(range)}`)
  }
})

// ── caret: same major, minor/patch at or above the floor ─────────────────────
check('caret with only a major locks the major', () => {
  assert.equal(satisfiesApiVersion('^2', '2.9.9'), true)
  assert.equal(satisfiesApiVersion('^2', '1.9.9'), false)
  assert.equal(satisfiesApiVersion('^2', '3.0.0'), false)
})
check('caret with a minor rejects earlier minors', () => {
  assert.equal(satisfiesApiVersion('^2.1', '2.5.0'), true)
  assert.equal(satisfiesApiVersion('^2.1', '2.0.9'), false)
})
check('caret with a patch enforces the patch floor', () => {
  assert.equal(satisfiesApiVersion('^2.1.0', '2.0.9'), false)
  assert.equal(satisfiesApiVersion('^2.1.0', '2.1.0'), true)
  assert.equal(satisfiesApiVersion('^2.1.0', '2.1.9'), true)
})

// ── tilde: same major and minor, any patch at or above the floor ─────────────
check('tilde with a minor accepts later patches but not a later minor', () => {
  assert.equal(satisfiesApiVersion('~2.1', '2.1.9'), true)
  assert.equal(satisfiesApiVersion('~2.1', '2.2.0'), false)
})
check('tilde with a patch enforces the patch floor within the minor', () => {
  assert.equal(satisfiesApiVersion('~2.1.3', '2.1.3'), true)
  assert.equal(satisfiesApiVersion('~2.1.3', '2.1.4'), true)
})

// ── x-range and bare major ───────────────────────────────────────────────────
check('x-range matches only the named major (and named minor)', () => {
  assert.equal(satisfiesApiVersion('2.x', '2.5.0'), true)
  assert.equal(satisfiesApiVersion('2.x', '3.0.0'), false)
})
check('a bare major matches every version of that major', () => {
  assert.equal(satisfiesApiVersion('2', '2.0.0'), true)
  assert.equal(satisfiesApiVersion('2', '2.9.9'), true)
  assert.equal(satisfiesApiVersion('2', '3.0.0'), false)
})

// ── bounded range ────────────────────────────────────────────────────────────
check('a lower-bound-only range accepts that major and above', () => {
  assert.equal(satisfiesApiVersion('>=2', '2.0.0'), true)
  assert.equal(satisfiesApiVersion('>=2', '1.9.9'), false)
})
check('a bounded range is inclusive at its floor and exclusive at its ceiling', () => {
  assert.equal(satisfiesApiVersion('>=2 <3', '1.9.9'), false)
  assert.equal(satisfiesApiVersion('>=2 <3', '2.0.0'), true)
  assert.equal(satisfiesApiVersion('>=2 <3', '2.7.0'), true)
  assert.equal(satisfiesApiVersion('>=2 <3', '3.0.0'), false)
})

// ── fail closed ──────────────────────────────────────────────────────────────
check('a malformed range rejects every host', () => {
  assert.equal(satisfiesApiVersion('garbage', '2.5.0'), false)
})
check('a malformed host is rejected by a concrete range', () => {
  for (const host of ['banana', '', '1.2']) {
    assert.equal(satisfiesApiVersion('^2', host), false, `host ${JSON.stringify(host)}`)
  }
})
check('a pre-release host does not satisfy a released range floor', () => {
  assert.equal(satisfiesApiVersion('^2', '1.2.3-rc.1'), false)
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\napi-version: all checks passed')
