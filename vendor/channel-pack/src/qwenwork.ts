/**
 * 千问办公（QwenWorkCN）渠道 —— 协议常量、凭据类型与信封解析。
 *
 * ## 协议来源（全部实测验证，2026-10-18）
 *
 * - 网关 `gateway.qwenwork.cn`，加密推理端点与 Qoder **同型**：
 *   `POST /algo/api/v2/service/pro/sse/agent_chat_generation?...&Encode=1`，
 *   请求体由官方 WASM `qoder_auth_wasm`（本渠道自带 `qwenwork-auth-wasm.wasm`）
 *   的 `qodercontext_prepareInferRequest` 打包。
 * - 版本身份从官方桌面客户端 1.0.4（asar 直读）冻结；**每日赠分领取**走
 *   OpenAPI 身份（1.3.1 客户端），与 chat 身份不同 —— 两者混用会被网关拒。
 * - `auth-v2.dat` = Electron `safeStorage.encryptString(JSON)`：
 *   - macOS：钥匙串 `QwenWorkCN Safe Storage`（PBKDF2-SHA1/"saltysalt"/1003
 *     → AES-128-CBC，IV 为 16 个空格，PKCS5 padding，`v10` 前缀）；
 *   - Windows：`Local State` 的 DPAPI `encrypted_key` → AES-256-GCM
 *     （`v10` + 12B nonce）—— 见 Buddy2api store.py；本文件先实现 macOS
 *     与明文 JSON 两条路径，Windows 待实测后补。
 * - 端到端实测（2026-10-18，真实账号）：claim 端点 200；wasm 打包后
 *   `qwork-advanced` 对话 200，SSE 信封 `{statusCodeValue, body}` 剥壳后为
 *   OpenAI chunk 流，usage 完整。
 */

import type { QwenworkModelEntry } from './qwenwork-product.js'

// ===== 网关与端点 =====

export const QWENWORK_GATEWAY = 'https://gateway.qwenwork.cn'

/** 加密推理端点（Encode=1 由 WASM 追加，勿手拼）。 */
export const QWENWORK_CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation'
export const QWENWORK_CHAT_QUERY = 'FetchKeys=llm_model_result&AgentId=agent_common'
/** deviceToken 续期（OpenAPI 身份，1.3.1）。 */
export const QWENWORK_REFRESH_PATH = '/api/v1/deviceToken/refresh'
/** 每日赠分领取（OpenAPI 身份，1.3.1，**无 body** POST）。 */
export const QWENWORK_DAILY_CLAIM_PATH = '/api/v1/adapter/user/daily-credit-notice/claim'
/**
 * 账号上下文（含 `quota`）—— 官方客户端查积分余额用的端点
 * （asar `ACCOUNT_CONTEXT_PATH`；OpenAPI 身份 1.3.1，GET + Bearer）。
 *
 * 实测（2026-10-19，真实账号，gateway.qwenwork.cn）200：
 * `{"code":"ok","data":{..., "quota":{"total":null,"used":null,"remaining":2099.7217,"exceeded":false}}}`
 * —— 免费版不下发 total/used，只有 `remaining`（小数）与 `exceeded`。
 */
export const QWENWORK_ACCOUNT_CONTEXT_PATH =
  '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing'

// ===== 版本身份（冻结自官方客户端 asar） =====

/** chat 请求身份（1.0.4 桌面端）。 */
export const QWENWORK_IDE_VERSION = '1.0.4'
export const QWENWORK_RELEASE_VERSION = '1.0.4-26090412'
export const QWENWORK_BUILD = '26090412'
export const QWENWORK_USER_AGENT = 'qoderwork/1.0.4'
/** COSY 版本（1.0.4 客户端冻结；与服务端校验绑定，勿随客户端升级而改）。 */
export const QWENWORK_COSY_VERSION = '1.1.32'
export const QWENWORK_CLIENT_TYPE = '6'
export const QWENWORK_BUSINESS_PRODUCT = 'qoder_work'
export const QWENWORK_BUSINESS_TYPE = 'agent'
export const QWENWORK_SCENE = 'qwork'
export const QWENWORK_MACHINE_OS = 'x86_64_win32'
export const QWENWORK_MACHINE_TYPE = '5'
export const QWENWORK_LOGIN_VERSION = 'v2'
export const QWENWORK_DATA_POLICY = 'disagree'

/** 每日赠分 / 续期身份（1.3.1 客户端；与 chat 身份不同源）。 */
export const QWENWORK_CLAIM_IDE_VERSION = '1.3.1'
export const QWENWORK_CLAIM_RELEASE_VERSION = '1.3.1-26101419'
export const QWENWORK_CLAIM_BUILD = '26101419'
export const QWENWORK_CLAIM_APP_MODE = 'standard'
export const QWENWORK_CLAIM_USER_AGENT = 'QwenWork/1.3.1'
export const QWENWORK_OPENAPI_USER_AGENT = 'qoderwork/1.3.1'

/**
 * 官方 0.1.8 asar `generateAuthToken` RSA 公钥（PKCS#1 v1.5）。
 * 仅用于把「用户身份材料」的 AES key 加密给服务端 —— 不是传输加密。
 */
export const QWENWORK_RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** 可重试的 HTTP 状态（与官方客户端口径一致）。 */
export const QWENWORK_RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  408, 409, 425, 429, 500, 502, 503, 504,
])

// ===== 模型 =====

/** 模型名别名（accept 官方客户端的下拉名 + 常见简写）。 */
export const QWENWORK_MODEL_ALIASES: Readonly<Record<string, string>> = {
  auto: 'qwork-advanced',
  pro: 'qwork-advanced',
  advanced: 'qwork-advanced',
  'qwork-advanced': 'qwork-advanced',
  flash: 'qwork-auto',
  standard: 'qwork-auto',
  'qwork-auto': 'qwork-auto',
  ultimate: 'qwork-ultimate',
  premium: 'qwork-ultimate',
  flagship: 'qwork-ultimate',
  'qwork-ultimate': 'qwork-ultimate',
  lite: 'qwork-lite',
  'qwork-lite': 'qwork-lite',
}

/** 归一化模型名（未知名字原样返回 —— 上游可能新增档位）。 */
export function normalizeQwenworkModel(model: string): string {
  const inner = (model || 'qwork-advanced').trim() || 'qwork-advanced'
  return QWENWORK_MODEL_ALIASES[inner] ?? inner
}

/** 兜底模型表（远端目录端点需 WASM 签名，v1 用静态表）。 */
export function qwenworkFallbackEntries(): readonly QwenworkModelEntry[] {
  return QWENWORK_FALLBACK_MODELS
}

// ===== 凭据 =====

/** 一条千问办公凭据（与 auth-v2.dat 明文结构对齐）。 */
export interface QwenworkCredential {
  /** 访问令牌（JWT；chat 与 OpenAPI 共用）。 */
  access_token: string
  /** 续期令牌（`ory_rt_` 前缀；可能先于 access_token 过期）。 */
  refresh_token: string
  /** access_token 过期时间（毫秒；0 = 未知）。 */
  expires_at: number
  /** refresh_token 过期时间（毫秒；0 = 未知）。 */
  refresh_expires_at: number
  /** 用户 id（auth-v2.dat `user.id`）。 */
  uid: string
  /** 用户名（展示用）。 */
  name: string
  /** 邮箱（占位：手机号登录时是 `phone_*@phone.local`）。 */
  email: string
  /** 登录设备 id（`loginDeviceId`；作为 Cosy-MachineId 透传）。 */
  machine_id: string
  /** 凭据来源（`local` / `paste`），排查用。 */
  source: string
}

/** auth-v2.dat 明文 schema（schemaVersion === 2）。 */
export interface QwenworkAuthDocument {
  schemaVersion: number
  token: string
  refreshToken: string
  expiresAt: string
  refreshTokenExpiresAt?: string
  loginDeviceId?: string
  loginMethod?: string
  refreshStrategy?: string
  user?: { id?: string; name?: string; email?: string }
  [key: string]: unknown
}

/** ISO 时间 → 毫秒（非法/缺失返回 0）。 */
export function qwenworkIsoToMs(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000
  const text = String(value).trim()
  if (text === '') return 0
  const parsed = Date.parse(text.endsWith('Z') || text.includes('+') ? text : `${text}Z`)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** JWT `exp` → 毫秒（解析失败返回 0）。 */
export function qwenworkJwtExpMs(token: string): number {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return 0
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    ) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

/** 是否已过期（默认提前 5 分钟视为过期）。 */
export function isQwenworkExpired(credential: QwenworkCredential, skewMs = 300_000): boolean {
  const expiresAt = credential.expires_at
    || qwenworkJwtExpMs(credential.access_token)
  if (expiresAt <= 0) return false
  return Date.now() >= expiresAt - skewMs
}

/**
 * auth-v2.dat 明文 → 凭据。
 *
 * ⚠️ 官方 `AuthStore.parse` 要求 `schemaVersion === 2` 且
 * `token/refreshToken/expiresAt/user.id` 均为字符串 —— 照抄校验，
 * 不放宽（放宽会把半损坏的文档当成可用凭据）。
 */
export function parseQwenworkDocument(doc: QwenworkAuthDocument): QwenworkCredential {
  if (doc.schemaVersion !== 2) {
    throw new Error(`auth-v2.dat schemaVersion 不受支持：${String(doc.schemaVersion)}`)
  }
  if (
    typeof doc.token !== 'string' || typeof doc.refreshToken !== 'string'
    || typeof doc.expiresAt !== 'string'
    || !doc.user || typeof doc.user.id !== 'string'
  ) {
    throw new Error('auth-v2.dat 缺少必需字段（token / refreshToken / expiresAt / user.id）')
  }
  return {
    access_token: doc.token,
    refresh_token: doc.refreshToken,
    expires_at: qwenworkIsoToMs(doc.expiresAt),
    refresh_expires_at: qwenworkIsoToMs(doc.refreshTokenExpiresAt),
    uid: doc.user.id,
    name: doc.user.name ?? '',
    email: doc.user.email ?? '',
    machine_id: doc.loginDeviceId ?? '',
    source: 'local',
  }
}

// ===== SSE 信封 =====

/**
 * 剥 QwenWork 外层信封：`{statusCodeValue, body}` → 内层 OpenAI SSE 文本数组。
 *
 * 实测外层形态：`{"statusCodeValue":200,"body":"<OpenAI chunk JSON 字符串>"}`
 * 与 `{"statusCodeValue":200,"body":{...}}`（对象直出）两种；错误时
 * `statusCodeValue >= 400` 或 `body.code ∈ {400,401,403}`。
 */
export function unwrapQwenworkSsePayload(raw: string): string[] {
  const text = (raw || '').trim()
  if (text === '' || text === '[DONE]' || text === '{}' || text === 'null') return []
  const envelopeError = qwenworkEnvelopeError(text)
  if (envelopeError !== null) return []
  let outer: unknown
  try {
    outer = JSON.parse(text)
  } catch {
    return [text]
  }
  if (typeof outer !== 'object' || outer === null) return [text]
  const obj = outer as Record<string, unknown>
  // 已经是 OpenAI chunk（部分上游直出）
  if ('choices' in obj || obj.object === 'chat.completion.chunk' || obj.object === 'chat.completion') {
    return [text]
  }
  const inner = obj.body
  if (inner === undefined || inner === null) return []
  if (typeof inner === 'object') {
    const dumped = JSON.stringify(inner)
    return dumped === '{}' || dumped === '[]' ? [] : [dumped]
  }
  const innerText = String(inner).trim()
  if (innerText === '' || innerText === '[DONE]' || innerText === '{}' || innerText === 'null') {
    return []
  }
  return [innerText]
}

/** 从信封文本提取错误信息；不是错误返回 `null`。 */
export function qwenworkEnvelopeError(raw: string): string | null {
  const text = (raw || '').trim()
  if (text === '') return null
  let outer: unknown
  try {
    outer = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof outer !== 'object' || outer === null) return null
  const obj = outer as Record<string, unknown>
  const status = obj.statusCodeValue
  let payload: unknown = obj.body
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      payload = { message: payload }
    }
  }
  if (typeof status === 'number' && status >= 400) {
    if (typeof payload === 'object' && payload !== null) {
      const p = payload as Record<string, unknown>
      return String(p.message ?? p.code ?? status)
    }
    return String(obj.body ?? status)
  }
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>
    const code = String(p.code ?? '')
    if (code === '400' || code === '401' || code === '403') {
      return String(p.message ?? code)
    }
  }
  return null
}

// ===== 兜底模型表 =====

/** 兜底模型表（官方 1.0.4 客户端枚举；`qwork-lite` 已于 2026-09-18 下线，保留占位）。 */
export const QWENWORK_FALLBACK_MODELS: readonly QwenworkModelEntry[] = [
  {
    id: 'qwork-advanced',
    name: 'qwork-advanced · 高级（推荐）',
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    supportsImage: true,
  },
  {
    id: 'qwork-auto',
    name: 'qwork-auto · 基础（省积分）',
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    supportsImage: true,
  },
  {
    id: 'qwork-ultimate',
    name: 'qwork-ultimate · 旗舰',
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    supportsImage: true,
  },
]
