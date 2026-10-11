export type Page = 'overview' | 'models' | 'combos' | 'usage' | 'channels' | 'eac' | 'settings' | 'connection'
export interface Model {
  id: string
  name: string
  channel: string
  routable: boolean
  vision?: boolean
  reasoning?: boolean
  contextWindow?: number
  maxOutput?: number
  availability?: string
  ttftMs?: number | null
  disabled?: boolean
}
export interface Combo {
  id: string
  name: string
  models: string[]
  strategy: string
  stickyLimit: number
  enabled: boolean
}
export interface ComboDraft {
  id?: string
  name: string
  models: string[]
  strategy: string
  stickyLimit?: number
  enabled?: boolean
}
export interface ModelTestResult { ok: boolean; text: string; latencyMs: number }
export interface ServiceSettings {
  enabled: boolean
  exposeRegionModels: boolean
  streamRecovery: boolean
  standaloneProbe: boolean
  probeIntervalMinutes: number
  defaultMaxTokens: number
}
export interface Summary {
  version: string
  baseUrl: string
  dataDir: string
  networkMode: string
  automaticRefresh: boolean
  catalogSyncedAt: number
  settings: ServiceSettings
  channels: { state: string; error?: string }
  eacAuth?: { local?: boolean; authorized?: boolean; login?: string }
  catalog: Model[]
}
export interface Stats {
  requests: number
  requestFailures: number
  requestFailuresEstimated?: boolean
  logicalEstimated?: boolean
  turns: number
  failedTurns: number
  recoveredTurns: number
  days: { day: string; total: number }[]
  grand: { input: number; output: number; reasoning: number }
  models: UsageModel[]
  samples: { model?: string; ok?: boolean; error?: string; at?: number; ms?: number }[]
}
export interface UsageModel {
  model: string
  name: string
  calls: number
  turns: number
  input: number
  output: number
  reasoning: number
  failed: number
  failedTurns: number
  recoveredTurns: number
  avgTtftMs?: number | null
  tps?: number | null
}
export interface Snapshot { summary: Summary; stats: Stats }
/** 「同步到 WorkBuddy」（模型组全量）的结果计数。 */
export interface WorkbuddySyncResult { added: number; updated: number; removed: number; total: number }
/** 单模型「写入 WorkBuddy」的结果计数。 */
export interface WorkbuddyWriteResult { added: number; updated: number; total: number }
/** WorkBuddy 配置备份条目；entries 为 null 表示备份文件无法解析（禁用恢复）。 */
export interface WorkbuddyBackup { file: string; at: number; bytes: number; entries: number | null }
export interface Host {
  navigate(page: Page): void
  refresh(): Promise<void>
  copy(value: string): Promise<void>
  getApiKey(): Promise<string>
  rotateKey(): Promise<string>
  logout(): Promise<void>
  error(error: Error): void
  testModel(model: string, signal: AbortSignal): Promise<ModelTestResult>
  refreshModels(probe: boolean, signal: AbortSignal): Promise<void>
  setModelDisabled(id: string, disabled: boolean): Promise<void>
  saveSettings(settings: ServiceSettings): Promise<ServiceSettings>
  listCombos(): Promise<Combo[]>
  saveCombo(combo: ComboDraft): Promise<Combo[]>
  deleteCombo(id: string): Promise<Combo[]>
  syncCombosToWorkbuddy(): Promise<WorkbuddySyncResult>
  writeModelToWorkbuddy(id: string): Promise<WorkbuddyWriteResult>
  listWorkbuddyBackups(): Promise<WorkbuddyBackup[]>
  restoreWorkbuddyBackup(file: string): Promise<{ restored: boolean; total: number; at: number }>
}
