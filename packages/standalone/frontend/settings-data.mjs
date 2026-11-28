import { t } from './i18n.mjs'

/** @param {import('./types').ServiceSettings} settings */
export function settingsDraft(settings) {
  return {
    enabled: settings.enabled,
    exposeRegionModels: settings.exposeRegionModels,
    hideFreeModels: settings.hideFreeModels === true,
    hideEacModels: settings.hideEacModels === true,
    streamRecovery: settings.streamRecovery,
    standaloneProbe: settings.standaloneProbe,
    defaultMaxTokens: String(settings.defaultMaxTokens),
    probeIntervalMinutes: String(settings.probeIntervalMinutes),
    // The free lane's exit pool. The server sends masked labels only, so the
    // draft starts empty: an edit means pasting the whole list again, the same
    // trade the desktop page makes for a credential-shaped field.
    laneExits: '',
    laneMaxTries: String(settings.freeLane?.maxTries ?? 3),
  }
}

/** @param {ReturnType<typeof settingsDraft>} draft
 * @param {import('./types').ServiceSettings} saved */
export function settingsChanged(draft, saved) {
  const baseline = settingsDraft(saved)
  return Object.keys(baseline).some(key => draft[key] !== baseline[key])
}

/** 轮询可以更新基线，但不能覆盖草稿或正在保存的输入。
 * @param {{ saved: import('./types').ServiceSettings, draft: ReturnType<typeof settingsDraft> }} state
 * @param {import('./types').ServiceSettings} saved
 * @param {boolean} saving */
export function syncSettings(state, saved, saving) {
  return { saved, draft: saving || settingsChanged(state.draft, state.saved) ? state.draft : settingsDraft(saved) }
}

/** Only form-owned settings are submitted; preserve per-model choices made elsewhere.
 * @param {ReturnType<typeof settingsDraft>} draft */
export function validateSettingsDraft(draft) {
  /** @type {Partial<Record<'defaultMaxTokens' | 'probeIntervalMinutes' | 'laneMaxTries', string>>} */
  const errors = {}
  for (const [key, labelKey, min, max] of [
    ['defaultMaxTokens', 'cfg.maxTokens', 512, 131072],
    ['probeIntervalMinutes', 'cfg.interval', 1, 1440],
    ['laneMaxTries', 'cfg.laneMaxTries', 1, 8],
  ]) {
    const raw = String(draft[key] ?? '').trim()
    const value = Number(raw)
    if (!raw || !Number.isInteger(value) || value < min || value > max) {
      errors[key] = t.format('cfg.rangeError', { label: t(labelKey), min, max })
    }
  }
  const laneExits = String(draft.laneExits ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
  // An empty box means "keep the stored list", so the patch only carries the
  // exits when the owner actually typed some.
  const freeLane = { maxTries: Number(draft.laneMaxTries) }
  if (laneExits.length > 0) freeLane.proxies = laneExits
  return {
    errors,
    patch: Object.keys(errors).length ? null : {
      enabled: draft.enabled, exposeRegionModels: draft.exposeRegionModels,
      hideFreeModels: draft.hideFreeModels, hideEacModels: draft.hideEacModels,
      streamRecovery: draft.streamRecovery, standaloneProbe: draft.standaloneProbe,
      defaultMaxTokens: Number(draft.defaultMaxTokens), probeIntervalMinutes: Number(draft.probeIntervalMinutes),
      freeLane,
    },
  }
}
