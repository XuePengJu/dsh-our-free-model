export type Page = 'overview' | 'models' | 'combos' | 'usage' | 'logs' | 'channels' | 'settings'
export interface Model {
  id: string
  name: string
  channel: string
  routable: boolean
  hiddenByUser?: boolean
  hiddenByGroup?: boolean
  vision?: boolean
  reasoning?: boolean
  contextWindow?: number
  maxOutput?: number
  availability?: string
  /** 判定原文（探测/测试失败的具体原因，用于徽章的 title 展开）。 */
  availabilityDetail?: string | null
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
  hiddenModelIds: string[]
  hideFreeModels: boolean
  hideEacModels: boolean
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
export type UsagePeriod = 'day' | 'week' | 'month' | 'all'
export interface PeriodBounds {
  period: UsagePeriod
  start: string
  end: string
  days: string[]
  label: string
  ongoing: boolean
  note?: string
}
export interface PeriodMetrics {
  turns: number | null
  requests: number
  input: number
  output: number
  reasoning: number
  failedTurns: number | null
  recoveredTurns: number | null
  failedRequests: number
  avgTtftMs: number | null
  tps: number | null
}
export interface ChartBar {
  key: string
  label: string
  total: number
  future?: boolean
  partial?: boolean
  title?: string
}
export interface UsagePeriodView {
  bounds: PeriodBounds
  metrics: PeriodMetrics
  models?: UsageModel[]
  chart: { bars: ChartBar[]; total: number; note: string; granularity: 'day' | 'month' }
  turnsAvailable: boolean
  note?: string
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
  grand: {
    input: number; output: number; reasoning: number
    calls?: number; failed?: number; turns?: number; failedTurns?: number; recoveredTurns?: number
  }
  models: UsageModel[]
  samples: { model?: string; ok?: boolean; error?: string; at?: number; ms?: number }[]
  periods?: Partial<Record<UsagePeriod, UsagePeriodView>>
}
export interface UsageModel {
  model: string
  name: string
  calls: number
  turns: number
  input: number
  output: number
  reasoning: number
  cacheRead?: number
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
  saveSettings(settings: Partial<ServiceSettings>): Promise<ServiceSettings>
  listCombos(): Promise<Combo[]>
  saveCombo(combo: ComboDraft): Promise<Combo[]>
  deleteCombo(id: string): Promise<Combo[]>
  syncCombosToWorkbuddy(baseUrl?: string, target?: 'ai'): Promise<WorkbuddySyncResult>
  writeModelToWorkbuddy(id: string, baseUrl?: string, target?: 'ai'): Promise<WorkbuddyWriteResult>
  listWorkbuddyBackups(): Promise<WorkbuddyBackup[]>
  restoreWorkbuddyBackup(file: string): Promise<{ restored: boolean; total: number; at: number }>
}
