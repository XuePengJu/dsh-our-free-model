/**
 * Model aliases: a readable name for a channel-minted model id.
 *
 * The failure this exists for is naming, not routing. An absorbed channel hands
 * back ids like `qodercn/qmodel_38max` — the first half is the routing prefix
 * `channels.handles()` matches on, the second half is an opaque upstream key.
 * Only `entry.name` carries meaning (`Qwen3.8-Max · x0.5`), and it never leaves
 * this process. A user pointing a second client at this gateway therefore has to
 * memorise the opaque half, and cannot tell from `/v1/models` what any row is.
 *
 * An alias is a second id for the same entry, minted from the display name:
 * `Qwen3.8-Max · x0.5` -> `qwen3.8-max`. It is resolved at the gateway *before*
 * routing, so the rest of the dispatch chain (disabled -> channel prefix ->
 * combo -> core) never learns aliases exist. Both ids stay valid, which is what
 * makes this additive: a client configured with the old id keeps working.
 *
 * Three invariants:
 *
 * - An alias never contains `/`. The channel dispatcher treats `provider/` as a
 *   routing prefix, so an alias with a slash could be mistaken for a channel id.
 * - An alias never collides with a real catalog id, an existing combo id, or
 *   another alias. Collisions are disambiguated with the channel name
 *   (`qwen3.8-max-qodercn`), then with a numeric suffix.
 * - An alias is never generated for an id that is already readable (a slug of
 *   itself): the free lane's ids are human names already, and aliasing them to
 *   the same string would only add a duplicate roster row.
 *
 * Generation is automatic and derived from the live catalog, not persisted. The
 * settings document only stores *overrides* — a renamed or switched-off alias —
 * so a channel refresh that drops or renames a model cannot leave stale aliases
 * pointing at entries that no longer exist.
 *
 * @module src/aliases.js
 */

export const ALIAS_MODES = Object.freeze(['both', 'alias', 'id'])
/**
 * What `/v1/models` advertises by default.
 *
 * `alias` — 只广播可读名。原始 id 照样能路由，所以切换模式不会让已配好的客户端
 * 突然 404；但清单里不再出现 `qodercn/qmodel_38max` 这种没人看得懂的名字。
 * 这是默认值，因为清单的第一读者是「往别的工具里加模型的人」。
 */
export const ALIAS_MODE_DEFAULT = 'alias'
export const ALIAS_MAX_LEN = 64
const ALIAS_MODE_SET = new Set(ALIAS_MODES)
const COMBO_PREFIX = 'combo:'

/** Letters, numbers and dots survive; every other separator becomes one dash. */
export function aliasFromName(name) {
  const head = String(name ?? '').split('·')[0]
  const slug = [...head.trim().toLowerCase()]
    .map(char => (/\p{Letter}|\p{Number}/u.test(char) || char === '.') ? char : '-')
    .join('')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, ALIAS_MAX_LEN)
    .replace(/[-.]+$/, '')
  return slug
}

/** The alias a catalog entry would get with no override: its display name. */
export function suggestedAlias(entry) {
  const fromName = aliasFromName(entry?.name)
  if (fromName !== '') return fromName
  return aliasFromName(entry?.id)
}

/**
 * Coerce the stored settings value into `{mode, overrides}`.
 *
 * The value came out of a JSON file, so every field is untrusted: an unknown
 * mode falls back to the default rather than being honoured as a typo, a non-object
 * override map becomes empty, and an override whose alias cannot be a valid id
 * keeps only its `enabled` bit — losing the rename is better than dropping the
 * user's request to switch the alias off.
 */
export function normalizeAliasSettings(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const mode = ALIAS_MODE_SET.has(value.mode) ? value.mode : ALIAS_MODE_DEFAULT
  const source = value.overrides !== null && typeof value.overrides === 'object' && !Array.isArray(value.overrides)
    ? value.overrides
    : {}
  const overrides = {}
  for (const [target, row] of Object.entries(source)) {
    const key = String(target ?? '').trim()
    if (key === '' || key.length > 300) continue
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const override = { enabled: row.enabled !== false }
    const alias = aliasFromName(row.alias)
    if (typeof row.alias === 'string' && row.alias.trim() !== '' && alias !== '' && !alias.includes('/')) {
      override.alias = alias
    }
    if (override.alias === undefined && override.enabled === true) continue
    overrides[key] = override
  }
  return { mode, overrides }
}

/** The alias settings as they should be shown back to a settings page. */
export function publicAliasSettings(raw) {
  const settings = normalizeAliasSettings(raw)
  return { mode: settings.mode, overrides: settings.overrides }
}

/**
 * Take `base` unless something already owns it.
 *
 * Real ids are reserved first (an alias can never shadow a routable model), then
 * earlier aliases. Two disambiguations, in order of how much they tell the user:
 *
 * 1. the channel that minted the entry — `qwen3.8-max-qodercn` answers "where
 *    does this one run", which is the question a duplicate name raises;
 * 2. the entry's own id tail — `deepseek-v4.1-flash-sg` — because channel names
 *    collide too (`workbuddy/deepseek-v4.1-flash` and `...-sg` share a display
 *    name), and the id already carries the distinction.
 *
 * A counter is the last resort: `foo-2` is a name nobody can reason about, so it
 * must only appear when the two meaningful forms are also taken.
 */
function claimAlias(base, id, reserved, used, entry) {
  const free = candidate => candidate !== '' && !reserved.has(candidate) && !used.has(candidate)
  if (free(base)) return base
  const channel = aliasFromName(entry?.channel)
  if (channel !== '' && channel !== 'combo') {
    const tagged = `${base.slice(0, ALIAS_MAX_LEN - channel.length - 1)}-${channel}`.replace(/^[-.]+/, '')
    if (free(tagged)) return tagged
  }
  const tail = aliasFromName(String(id ?? '').split('/').slice(1).join('/'))
  if (tail !== '' && tail !== base && tail.length <= ALIAS_MAX_LEN && free(tail)) return tail
  for (let index = 2; index <= 20; index += 1) {
    const suffix = `-${index}`
    const candidate = `${base.slice(0, ALIAS_MAX_LEN - suffix.length).replace(/[-.]+$/, '')}${suffix}`
    if (free(candidate)) return candidate
  }
  return ''
}

/**
 * Build the alias rows for the catalog as it stands right now.
 *
 * Two passes, and the split is the whole point. Pass one assigns names to *every*
 * entry, including the ones the user switched off or whose alias they renamed;
 * pass two emits only the rows that are still on. Assigning in one pass would let
 * a switched-off `glm-5.3` free its name for the next channel's `glm-5.3`, so a
 * client that had been talking to one model would silently start talking to
 * another. A switched-off alias must instead stay reserved and simply resolve to
 * nothing — a 404 names the mistake, a redirect hides it.
 *
 * Models that are not in the catalog are absent by construction (the aliases are
 * derived from it), which is the property that keeps `/v1/models` honest after a
 * channel drops a model: a stale alias cannot be advertised. Callers must hand in
 * the full catalog, disabled entries included, for the reservation to be stable.
 *
 * @param {Array<object>} catalog - every routable catalog entry, disabled ones included
 * @param {object} [rawSettings] - `settings.aliases`
 * @returns {Array<{alias: string, target: string, name: string, override: boolean}>}
 */
export function buildAliasRows(catalog, rawSettings) {
  const settings = normalizeAliasSettings(rawSettings)
  const entries = Array.isArray(catalog) ? catalog : []
  const reserved = new Set(entries.map(entry => String(entry?.id ?? '')).filter(id => id !== ''))
  const used = new Set()
  const claimed = new Map()
  for (const entry of entries) {
    const id = String(entry?.id ?? '').trim()
    if (id === '' || entry?.channel === 'combo' || id.startsWith(COMBO_PREFIX)) continue
    const explicit = settings.overrides[id]?.alias
    const wanted = explicit ?? suggestedAlias(entry)
    if (wanted === '') continue
    // An id that is already its own readable slug needs no second name.
    if (wanted === id) continue
    // An automatic name has to be ASCII: a display name written in Chinese slugs to
    // a Chinese id, and such an id travels badly through URLs, headers and the many
    // clients that re-encode model names. Falling back to the real id is honest;
    // guessing at a pinyin name would be worse. A hand-written override is the
    // user's call and is not second-guessed.
    if (explicit === undefined && !/[a-z0-9]/.test(wanted)) continue
    const alias = claimAlias(wanted, id, reserved, used, entry)
    if (alias === '') continue
    used.add(alias)
    claimed.set(id, alias)
  }
  const rows = []
  for (const entry of entries) {
    const id = String(entry?.id ?? '').trim()
    const alias = claimed.get(id)
    if (alias === undefined) continue
    if (settings.overrides[id]?.enabled === false) continue
    rows.push({
      alias, target: id, name: String(entry?.name ?? id),
      override: settings.overrides[id]?.alias !== undefined,
    })
  }
  return rows
}

/** `alias -> target`, built once per caller that resolves many ids. */
export function aliasIndex(rows) {
  const index = new Map()
  for (const row of rows) if (row.alias !== row.target) index.set(row.alias, row.target)
  return index
}

/**
 * The `/v1/models` row an alias is advertised as.
 *
 * Everything about the model — context window, efforts, vision, price — is
 * inherited, because an alias is the same model under a second name. The `name`
 * is *not* inherited, and that is the whole point: a client builds its picker as
 * a `display name -> model` table, so an alias row carrying its target's display
 * name is indistinguishable from a duplicate and gets dropped. Both ids then work
 * but only the opaque one is offered, which is the bug this function exists to
 * prevent.
 *
 * @param {object} target - the catalog row for the real id
 * @param {string} alias - the readable name to advertise
 * @returns {object} a model row whose `id` and `name` are both the alias
 */
export function aliasModelRow(target, alias) {
  return { ...target, id: alias, name: alias, x_ofm_alias_of: target.id }
}

/**
 * Map one incoming model name onto its real id.
 *
 * Matching is exact first, then case-insensitive: a client that title-cases a
 * model name is making a display choice, not a routing mistake. A name that
 * matches nothing is returned untouched, so this stays a pass-through for every
 * request that was already correct.
 */
export function resolveModelAlias(model, rows) {
  const text = typeof model === 'string' ? model.trim() : ''
  if (text === '') return text
  const index = aliasIndex(rows)
  const direct = index.get(text)
  if (direct !== undefined) return direct
  const lower = text.toLowerCase()
  for (const [alias, target] of index) if (alias.toLowerCase() === lower) return target
  return text
}
