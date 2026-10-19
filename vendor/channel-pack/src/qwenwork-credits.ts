/**
 * 千问办公渠道 —— 积分领取与令牌续期（OpenAPI 身份，1.3.1 客户端）。
 *
 * ## 两个身份面（与 chat 的 1.0.4 身份**不同源**，混用会被网关拒）
 *
 * - **续期**：`POST /api/v1/deviceToken/refresh`，1.3.1 OpenAPI 头，
 *   **不带 Authorization**（带 access_token 反而让网关先判 access token、
 *   掩盖可用的 refresh token —— Buddy2api 实测）。
 * - **每日赠分**：`POST /api/v1/adapter/user/daily-credit-notice/claim`，
 *   `QwenWork/1.3.1` UA，**无 body**（`Content-Type`+`{}` 会 400）。
 *   实测（2026-10-18，真实账号）200：`{"code":"ok","data":{"should_show":false,"credits":0}}`
 *   —— `should_show=false` 且 credits=0 表示「今日已领/没有新赠分」。
 */

import {
  QWENWORK_ACCOUNT_CONTEXT_PATH,
  QWENWORK_CLAIM_APP_MODE,
  QWENWORK_CLAIM_BUILD,
  QWENWORK_CLAIM_IDE_VERSION,
  QWENWORK_CLAIM_RELEASE_VERSION,
  QWENWORK_CLAIM_USER_AGENT,
  QWENWORK_DAILY_CLAIM_PATH,
  QWENWORK_GATEWAY,
  QWENWORK_OPENAPI_USER_AGENT,
  QWENWORK_REFRESH_PATH,
  isQwenworkExpired,
  type QwenworkCredential,
} from './qwenwork.js'
import { roundCredits, type CreditBalance } from './credits.js'

/** 续期/领取共享的 OpenAPI 身份头。 */
function openapiHeaders(requestId: string, withAuth: boolean, accessToken: string, userAgent: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': userAgent,
    'X-Request-Id': requestId,
    'X-QwenWork-Version': QWENWORK_CLAIM_IDE_VERSION,
    'X-QwenWork-Release-Version': QWENWORK_CLAIM_RELEASE_VERSION,
    'X-QwenWork-Build': QWENWORK_CLAIM_BUILD,
    'X-QwenWork-Platform': 'win32',
    'X-QwenWork-Arch': 'x64',
    'X-QwenWork-Channel': 'stable',
    'X-QwenWork-App-Mode': QWENWORK_CLAIM_APP_MODE,
    'Content-Type': 'application/json',
  }
  if (withAuth && accessToken !== '') headers.Authorization = `Bearer ${accessToken}`
  return headers
}

/** 续期结果（新凭据字段）。 */
export interface QwenworkRefreshResult {
  access_token: string
  refresh_token: string
  expires_at: number
  refresh_expires_at: number
}

/** 调续期端点一次；失败抛错（调用方决定降级策略）。 */
export async function refreshQwenworkCredential(
  credential: QwenworkCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<QwenworkRefreshResult> {
  if (credential.refresh_token === '') {
    throw new Error('qwenwork: 凭据没有 refresh_token，无法续期')
  }
  // ⚠️ 官方 1.3.1 续期只带 refresh_token —— 不带 Authorization
  const response = await fetchImpl(`${QWENWORK_GATEWAY}${QWENWORK_REFRESH_PATH}`, {
    method: 'POST',
    headers: openapiHeaders(`ofm-${Date.now()}`, false, '', QWENWORK_OPENAPI_USER_AGENT),
    body: JSON.stringify({ refresh_token: credential.refresh_token, target: 'c' }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`qwenwork: 续期失败 HTTP ${response.status} — ${text.slice(0, 240)}`)
  }
  const data = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (typeof data !== 'object' || data === null) {
    throw new Error('qwenwork: 续期响应不是 JSON')
  }
  const token = firstString(data.device_token, data.token, data.access_token)
  if (token === '') throw new Error('qwenwork: 续期响应缺少 device_token')
  const now = Date.now()
  return {
    access_token: token,
    refresh_token: firstString(data.refresh_token, credential.refresh_token),
    expires_at: isoOrInMs(data.expires_at, data.expires_in, now),
    refresh_expires_at: isoOrInMs(data.refresh_token_expires_at, data.refresh_token_expires_in, now),
  }
}

/** 每日赠分领取结果。 */
export interface QwenworkClaimResult {
  ok: boolean
  /** 本次成功领取。 */
  claimed: boolean
  /** 今日已领过（或没有新赠分）。 */
  alreadyClaimed: boolean
  /** 到账积分。 */
  credit: number
  message: string
}

/** 领取每日赠分。 */
export async function claimQwenworkDailyCredit(
  credential: QwenworkCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<QwenworkClaimResult> {
  // ⚠️ 无 body 的 POST：不带 Content-Type、不带 body（带 `{}` 会 400）
  const headers = openapiHeaders(
    `ofm-${Date.now()}`, true, credential.access_token, QWENWORK_CLAIM_USER_AGENT,
  )
  delete headers['Content-Type']
  const response = await fetchImpl(`${QWENWORK_GATEWAY}${QWENWORK_DAILY_CLAIM_PATH}`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('qwenwork: 领取被拒（401/403）——访问令牌可能已失效，请续期或重新导入')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { ok: false, claimed: false, alreadyClaimed: false, credit: 0, message: `HTTP ${response.status} — ${text.slice(0, 200)}` }
  }
  const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
  const data = unwrapClaimData(payload)
  const credits = typeof data.credits === 'number' && Number.isInteger(data.credits) && data.credits > 0
    ? data.credits
    : 0
  if (data.should_show === true && credits > 0) {
    return { ok: true, claimed: true, alreadyClaimed: false, credit: credits, message: `领取成功 +${credits}` }
  }
  if (credits > 0) {
    return { ok: true, claimed: false, alreadyClaimed: true, credit: credits, message: `今日已领 ${credits}` }
  }
  return { ok: true, claimed: false, alreadyClaimed: true, credit: 0, message: '今日没有新的赠分' }
}

/** 凭据是否需要续期（过期或临期 5 分钟）。 */
export function qwenworkNeedsRefresh(credential: QwenworkCredential): boolean {
  return isQwenworkExpired(credential)
}

/**
 * 查询千问办公积分余额（官方客户端同款端点）。
 *
 * `GET {gateway}/api/v1/adapter/user/account-context?include=user,plan,quota,...`
 * （OpenAPI 身份 1.3.1 + Bearer，与每日领取同源同签名要求）。
 *
 * 实测（2026-10-19）响应 `data.quota`：免费版 `total/used` 为 `null`，
 * 只有 `remaining`（含小数，如 2099.7217）与 `exceeded` 布尔。映射成
 * **单包** `CreditBalance`：`total/used` 无从得知就如实给 0，`remaining`
 * 用上游值四舍五入到两位；`exceeded=true` 时包标记为失效（active=false）。
 * 网络/凭据失败返回 `null`（调用方按「查询失败」呈现，不显示成 0）。
 */
export async function fetchQwenworkQuotaBalance(
  credential: QwenworkCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const headers = openapiHeaders(
    `ofm-${Date.now()}`, true, credential.access_token, QWENWORK_CLAIM_USER_AGENT,
  )
  try {
    const response = await fetchImpl(`${QWENWORK_GATEWAY}${QWENWORK_ACCOUNT_CONTEXT_PATH}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return null
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
    const data = unwrapClaimData(payload)
    const quota = typeof data.quota === 'object' && data.quota !== null
      ? data.quota as Record<string, unknown>
      : undefined
    const remaining = typeof quota?.remaining === 'number' && Number.isFinite(quota.remaining)
      ? quota.remaining
      : undefined
    if (remaining === undefined) return null
    const exceeded = quota?.exceeded === true
    const plan = typeof data.plan === 'object' && data.plan !== null
      ? data.plan as Record<string, unknown>
      : {}
    const planName = typeof plan.name === 'string' && plan.name.length > 0 ? plan.name : '千问办公'
    return {
      total: roundCredits(remaining),
      expiredTotal: 0,
      packages: [{
        name: `${planName}积分`,
        unit: 'credit',
        remaining: roundCredits(remaining),
        // 上游免费版不下发 total/used（null）—— 如实给 0，UI 只展示 remaining。
        total: 0,
        used: 0,
        active: !exceeded,
        cycleStartTime: '',
        cycleEndTime: '',
        expiredTime: '',
      }],
    }
  } catch {
    return null
  }
}

function unwrapClaimData(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  let data: unknown = payload
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof data === 'object' && data !== null && 'data' in (data as Record<string, unknown>)) {
      data = (data as Record<string, unknown>).data
    } else {
      break
    }
  }
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
}

function isoOrInMs(iso: unknown, seconds: unknown, nowMs: number): number {
  if (typeof iso === 'string' && iso !== '') {
    const parsed = Date.parse(iso)
    if (!Number.isNaN(parsed)) return parsed
  }
  if (typeof seconds === 'number' && seconds > 0) return nowMs + seconds * 1000
  return 0
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}
