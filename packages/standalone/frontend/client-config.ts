// 「接入配置一键复制」的纯逻辑层：把 Base URL + API Key + 模型 ID 组装成
// 一段 JSON，并提供默认模型 ID 的解析与本地持久化（localStorage）。
// 不依赖 React，方便在任意入口（概览 / 模型清单 / 模型组）复用与测试。
import type { Model } from './types'

/** 默认模型 ID 在 localStorage 中的键名。 */
export const CLIENT_MODEL_STORAGE_KEY = 'ofm:client-model'

/**
 * 组装一次性复制的接入配置 JSON（驼峰字段）。
 * apiKey 为空（获取失败降级）时不写入该字段，避免把空串当真 Key 用。
 * @param baseUrl 已含 `/v1` 后缀的完整接入地址（由调用方用 resolveEndpointBase 拼好）
 * @param apiKey 用户的 API Key；获取失败传 undefined
 * @param model 模型 ID 或模型组 ID，原样写入
 */
export function buildClientConfig(baseUrl: string, apiKey: string | undefined, model: string): string {
  return JSON.stringify({ baseUrl, ...(apiKey ? { apiKey } : {}), model })
}

/**
 * 解析默认接入模型 ID，优先级：
 * 1. saved 且 catalog 中存在同 id 且 routable 的模型
 * 2. catalog 中第一个 channel === 'combo' 且 routable 的模型
 * 3. catalog 中第一个 routable 的模型
 * 4. catalog[0]?.id（兜底，可能不可接入）／catalog 为空时返回 ''
 */
export function resolveDefaultModelId(catalog: Model[], saved?: string): string {
  if (saved) {
    const matched = catalog.find(row => row.id === saved && row.routable)
    if (matched) return matched.id
  }
  const combo = catalog.find(row => row.channel === 'combo' && row.routable)
  if (combo) return combo.id
  const routable = catalog.find(row => row.routable)
  if (routable) return routable.id
  return catalog[0]?.id ?? ''
}

/** 读取上一次保存的默认模型 ID；localStorage 不可用时静默降级为 undefined。 */
export function loadSavedModelId(): string | undefined {
  try { return localStorage.getItem(CLIENT_MODEL_STORAGE_KEY) ?? undefined }
  catch { return undefined }
}

/** 保存默认模型 ID；隐私模式等场景下静默降级，仅影响下次记忆。 */
export function saveClientModelId(id: string): void {
  try { localStorage.setItem(CLIENT_MODEL_STORAGE_KEY, id) } catch { /* 静默降级 */ }
}
