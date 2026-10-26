/**
 * The degradation ring: what a chain tried before it answered.
 *
 * A combo's advance loop is the one place where a turn can quietly try several
 * models. The turn record (`recordTurn`) only says "this turn took N attempts";
 * it cannot say *which* candidates were walked past, why, or how long each one
 * burned before it was dropped. Those three facts are what makes a failover
 * explainable — "the chain answered" and "the chain answered because two links
 * were rate-limited and one was region-blocked" are different stories.
 *
 * Storage is deliberately the existing stats store rather than a store of its
 * own: the harness adapter (`src/adapter.js#runCombo`) and the standalone
 * forward path (`packages/standalone/service.mjs#completeCombo`) are two code
 * paths that must feed one panel, and the stats store is the only thing both
 * already write through. Persistence, locking and trimming come for free.
 *
 * Two properties this module must never lose:
 *
 * 1. **Recording may not affect inference.** Every write entry point swallows
 *    its own errors: a full disk, a disposed store, a malformed row must cost
 *    a log line, never a request. The call sites wrap it again — belt and
 *    braces, because the adapter's call site is on the hot path and a future
 *    injected `recordAttempt` may throw where this module would not.
 * 2. **No IO on the hot path.** One `unshift` and a truncation. `JsonStore`
 *    debounces its own flush (800 ms, unref'd timer), so nothing here waits on
 *    a file.
 *
 * Rows carry no speed: `tps` / `ttftMs` only exist inside `runSingle`'s decode
 * window, and `runCombo` never sees them. Guessing them from a failed result
 * would be fabrication — speed keeps coming from the ledger, where it is
 * measured per call.
 *
 * @module src/core/attempts.js
 */

/** Rows kept in memory (and on disk). Older rows fall off the tail. */
export const ATTEMPT_LIMIT = 200

/** Outcomes a row may carry. Anything else is a bug at the call site. */
const OUTCOMES = new Set(['hit', 'skipped', 'aborted'])

/**
 * Coerce one row to the exact shape the panel renders.
 *
 * Every field is defaulted rather than trusted: a row arrives from a generator
 * that may be unwinding an abort, and a `undefined` candidate id must show up
 * as an empty string instead of taking the whole ring down when it is written
 * out as JSON.
 *
 * @param {unknown} row - the caller's attempt row
 * @returns {{turnAt: number, at: number, chainId: string, chainName: string,
 *   index: number, candidateId: string, outcome: 'hit'|'skipped'|'aborted',
 *   reason: string, elapsedMs: number}}
 */
function normalizeAttempt(row) {
  const source = row !== null && typeof row === 'object' ? row : {}
  const at = Number.isFinite(source.at) ? source.at : Date.now()
  // `turnAt` is the turn's start, shared by every row of one walk. It is what
  // lets the panel group rows into a turn without guessing from timestamps.
  // Rows written before this field existed fall back to their own `at`, which
  // groups each one alone — the honest reading of "we never recorded the turn
  // start for this one", instead of collapsing them all onto 0.
  const turnAt = Number.isFinite(source.turnAt) ? source.turnAt : at
  const elapsedMs = Number.isFinite(source.elapsedMs) && source.elapsedMs >= 0
    ? Math.round(source.elapsedMs)
    : 0
  const index = Number.isSafeInteger(source.index) && source.index >= 0 ? source.index : 0
  return {
    turnAt,
    at,
    chainId: typeof source.chainId === 'string' ? source.chainId : '',
    chainName: typeof source.chainName === 'string' ? source.chainName : '',
    index,
    candidateId: typeof source.candidateId === 'string' ? source.candidateId : '',
    outcome: OUTCOMES.has(source.outcome) ? source.outcome : 'skipped',
    reason: typeof source.reason === 'string' ? source.reason : '',
    elapsedMs,
  }
}

/**
 * Trim a ring to `limit` rows, newest first.
 *
 * Exported for `store.edit` callers that want to re-apply the bound (a file
 * written by a future build with a larger limit, for example). A missing or
 * non-array value yields `[]` rather than throwing: every stats file written
 * before this feature existed has no `attempts` field at all.
 *
 * @param {unknown} value - whatever the store currently holds
 * @param {number} [limit]
 * @returns {Array<object>}
 */
export function pruneAttempts(value, limit = ATTEMPT_LIMIT) {
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : ATTEMPT_LIMIT
  if (!Array.isArray(value)) return []
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Prepend one attempt row and keep the ring bounded.
 *
 * Never throws: this runs while a caller is waiting for an answer.
 *
 * @param {{edit: (mutate: (state: object) => object) => unknown}} store - the stats store
 * @param {object} row - `{ turnAt, at, chainId, chainName, index, candidateId, outcome, reason, elapsedMs }`
 * @param {(message: string) => void} [warn] - logger sink; recording failures are invisible otherwise
 * @returns {unknown} the store's new value, or `undefined` when the write failed
 */
export function recordAttempt(store, row, warn) {
  try {
    return store.edit(state => {
      const ring = Array.isArray(state.attempts) ? state.attempts : []
      return { ...state, attempts: pruneAttempts([normalizeAttempt(row), ...ring], ATTEMPT_LIMIT) }
    })
  } catch (error) {
    // Swallowed on purpose: this is on the request path of a live inference.
    // The warn callback is itself guarded — a logger that throws must not turn
    // a recorded-nothing into a failed request either.
    try {
      warn?.(`our-free-model: could not record a chain attempt (${error?.message ?? error})`)
    } catch { /* a broken logger is not this module's problem */ }
    return undefined
  }
}

/**
 * Read the ring, newest first.
 *
 * Deliberately *not* wrapped in a try/catch: the only way this can fail is a
 * broken local store, and the endpoint must surface that as a local 500 rather
 * than pretend the upstream is unavailable.
 *
 * @param {{get: () => object}} store - the stats store
 * @param {{limit?: number}} [options] - clamped to `[1, ATTEMPT_LIMIT]`; a
 *   fractional or zero limit is a caller bug, and answering with one row is
 *   more useful than answering with the whole ring
 * @returns {Array<object>} shallow copies, so a caller cannot mutate the ring
 */
export function readAttempts(store, { limit = ATTEMPT_LIMIT } = {}) {
  const state = typeof store?.get === 'function' ? store.get() : undefined
  const ring = Array.isArray(state?.attempts) ? state.attempts : []
  const max = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), ATTEMPT_LIMIT)
    : ATTEMPT_LIMIT
  return ring.slice(0, max).map(row => ({ ...row }))
}
