/**
 * 千问办公渠道 —— **设备码网页登录（OAuth Device Flow）**。
 *
 * ## 为什么有这个文件
 *
 * v1 的登录模型是「本机官方客户端导入」（`qwenwork-store.ts` 解密
 * `auth-v2.dat`，macOS 需钥匙串授权）。那套只适合**自己在自己机器上跑**：
 * 给别人用要么共用同一账号，要么让对方装客户端 + 授权钥匙串。
 *
 * 实测（2026-10-19）官方客户端 1.3.1 的登录**就是标准 OAuth Device Flow**，
 * 可完整复刻（asar 依据：`main.js` 的 `startDeviceFlow` / `pollDeviceToken`）：
 *
 * ```
 * 1. 客户端生成 PKCE(S256) + nonce + machine_id
 * 2. 打开授权页：{authBase}/device/selectAccounts?challenge=..&challenge_method=S256
 *                &nonce=..&machine_id=..&client_id=..&redirect_uri=qwenwork-cn://
 *    → 302 到 qwenwork.cn/oauth2/auth（阿里账号登录/授权）
 * 3. 轮询：GET {gateway}/api/v1/deviceToken/poll?nonce=..&verifier=..&challenge_method=S256
 *    → 404 = 待授权；200 = 拿到 token（响应含 nonce/code_challenge 绑定校验）
 * ```
 *
 * 用户只需在浏览器登录**自己的**阿里账号 —— 不装客户端、不碰钥匙串，
 * 凭据归属各自账号（BYO），这正是「给别人用」要的形态。
 *
 * ## ⚠️ 三个实测踩过的坑
 *
 * 1. **authBase 是 `gateway.qwenwork.cn`**，不是裸域名 `qwenwork.cn`。
 *    asar 里 `index$k.ao` 实际等于 `Be = "gateway.qwenwork.cn"`（我第一版
 *    按裸域名拼，实测 404）。
 * 2. **链接一次性**（`DEVICE_FLOW_REPLAYED`）：nonce 被任何一次访问消费后
 *    即不可再用 —— 生成链接后**不能再由服务端自己预检**，否则用户打开必报
 *    重放。因此本模块**不提供**「先验证链接」的 API。
 * 3. **404 是正常中间态**（`{}` body），不是错误；只有 4xx 且非 404 才是真错。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  QWENWORK_CLAIM_APP_MODE,
  QWENWORK_CLAIM_BUILD,
  QWENWORK_CLAIM_IDE_VERSION,
  QWENWORK_CLAIM_RELEASE_VERSION,
  QWENWORK_CLAIM_USER_AGENT,
  QWENWORK_GATEWAY,
  type QwenworkCredential,
} from './qwenwork.js'

// ===== 协议常量（冻结自官方客户端 1.3.1） =====

/**
 * 授权页基准域名 —— **就是 gateway 域名**（见文件头坑 1）。
 * 授权链接形如 `https://gateway.qwenwork.cn/device/selectAccounts?...`。
 */
export const QWENWORK_DEVICE_AUTH_BASE = QWENWORK_GATEWAY
/** OAuth client id（桌面客户端 `QWENWORK_CN_CLIENT_ID`）。 */
export const QWENWORK_DEVICE_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'
/** 深链回调 scheme（客户端注册的 `qwenwork-cn://`）。 */
export const QWENWORK_DEVICE_REDIRECT_URI = 'qwenwork-cn://'
/** 轮询端点（OpenAPI 身份）。 */
export const QWENWORK_DEVICE_POLL_PATH = '/api/v1/deviceToken/poll'
/** 轮询间隔（官方 1s；这里略放缓，避免登录窗口打开前的无效请求）。 */
export const QWENWORK_DEVICE_POLL_INTERVAL_MS = 1500
/** 轮询总超时（官方 300s）。 */
export const QWENWORK_DEVICE_POLL_TIMEOUT_MS = 300_000

/** PKCE verifier 字符集（RFC 7636 unreserved）。 */
const PKCE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

// ===== 类型 =====

/** 一次设备码登录的本地状态（不含任何服务端机密）。 */
export interface QwenworkDeviceFlow {
  verifier: string
  challenge: string
  nonce: string
  machineId: string
  /** 给用户打开的授权链接（**一次性**）。 */
  authUrl: string
}

/** 轮询成功后的上游响应（字段实测来源：`pollDeviceToken` 的 200 body）。 */
export interface QwenworkDeviceTokenResponse {
  token: string
  refresh_token?: string
  /** access_token 过期时间（ISO 字符串）。 */
  expires_at?: string
  /** access_token 有效期（秒）。 */
  expires_in?: number
  nonce?: string
  code_challenge?: string
  code_challenge_method?: string
  user_id?: string
  user_name?: string
}

/** 单次轮询结果。 */
export type QwenworkDevicePollResult =
  | { status: 'pending' }
  | { status: 'done'; tokens: QwenworkDeviceTokenResponse }

// ===== 生成 flow =====

/** 生成 PKCE 对（S256）。 */
function createPkce(): { verifier: string; challenge: string } {
  const length = 43 + Math.floor(Math.random() * 86) // 43..128
  const bytes = randomBytes(length)
  let verifier = ''
  for (let i = 0; i < length; i += 1) {
    verifier += PKCE_ALPHABET[bytes[i]! % PKCE_ALPHABET.length]
  }
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return { verifier, challenge }
}

/**
 * 新建一次设备码登录。
 *
 * ⚠️ 返回的 `authUrl` **只能被用户打开一次**（服务端防重放）。生成后不要
 * 自己 fetch / curl 预检，否则用户再打开时必报 `DEVICE_FLOW_REPLAYED`。
 */
export function createQwenworkDeviceFlow(): QwenworkDeviceFlow {
  const { verifier, challenge } = createPkce()
  const nonce = randomUUID()
  const machineId = randomUUID()
  const params = new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    nonce,
    machine_id: machineId,
    client_id: QWENWORK_DEVICE_CLIENT_ID,
    redirect_uri: QWENWORK_DEVICE_REDIRECT_URI,
  })
  return {
    verifier,
    challenge,
    nonce,
    machineId,
    authUrl: `${QWENWORK_DEVICE_AUTH_BASE}/device/selectAccounts?${params.toString()}`,
  }
}

// ===== 轮询 =====

/** 轮询所需的客户端身份头（缺了会被网关按「非客户端」处理）。 */
function deviceHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Request-Id': randomUUID(),
    'X-QwenWork-Version': QWENWORK_CLAIM_IDE_VERSION,
    'X-QwenWork-Release-Version': QWENWORK_CLAIM_RELEASE_VERSION,
    'X-QwenWork-Build': QWENWORK_CLAIM_BUILD,
    'X-QwenWork-Platform': 'darwin',
    'X-QwenWork-Arch': 'arm64',
    'X-QwenWork-Channel': 'stable',
    'X-QwenWork-App-Mode': QWENWORK_CLAIM_APP_MODE,
    'User-Agent': QWENWORK_CLAIM_USER_AGENT,
  }
}

/** 默认 sleep（测试可注入替换，避免真等）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * **单次**轮询：返回 `pending`（用户还没授权完）或 `done`（已拿到 token）。
 *
 * 语义对照官方实现：
 * - `404` → 待授权（正常中间态）；
 * - `200` 且 body 有 `token` → 完成，并校验 nonce / code_challenge 绑定
 *   （不匹配视为异常响应，不落凭据）；
 * - 其它非 2xx → 抛错（带 errorCode / errorMessage，便于前端提示）。
 */
export async function pollQwenworkDeviceTokenOnce(
  flow: QwenworkDeviceFlow,
  fetchImpl: typeof fetch = fetch,
): Promise<QwenworkDevicePollResult> {
  const params = new URLSearchParams({
    nonce: flow.nonce,
    verifier: flow.verifier,
    challenge_method: 'S256',
  })
  const response = await fetchImpl(
    `${QWENWORK_GATEWAY}${QWENWORK_DEVICE_POLL_PATH}?${params.toString()}`,
    { method: 'GET', headers: deviceHeaders() },
  )
  if (response.status === 404) return { status: 'pending' }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let detail = text.slice(0, 200)
    try {
      const parsed = JSON.parse(text) as { errorCode?: string; errorMessage?: string }
      detail = [parsed.errorCode, parsed.errorMessage].filter(Boolean).join(': ') || detail
    } catch {
      // 非 JSON：保留原文片段
    }
    throw new Error(
      `qwenwork: 设备码轮询失败（HTTP ${response.status}）${detail ? ` —— ${detail}` : ''}`,
    )
  }
  const body = (await response.json()) as QwenworkDeviceTokenResponse
  if (typeof body.token !== 'string' || body.token.length === 0) {
    return { status: 'pending' }
  }
  // 绑定校验：响应必须回带本次 flow 的 nonce / challenge（官方同款防串号）。
  if (body.nonce !== undefined && body.nonce !== flow.nonce) {
    throw new Error('qwenwork: 设备码响应 nonce 不匹配（疑似串号），已拒绝落盘')
  }
  if (
    body.code_challenge !== undefined &&
    body.code_challenge !== flow.challenge
  ) {
    throw new Error('qwenwork: 设备码响应 code_challenge 不匹配，已拒绝落盘')
  }
  return { status: 'done', tokens: body }
}

/** 轮询选项（测试注入点）。 */
export interface QwenworkDeviceWaitOptions {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  intervalMs?: number
  timeoutMs?: number
  now?: () => number
}

/**
 * 循环轮询直到授权完成或超时。
 *
 * 超时抛错（文案引导用户重新发起「添加账号」——链接一次性，不能续用）。
 */
export async function waitForQwenworkDeviceLogin(
  flow: QwenworkDeviceFlow,
  options: QwenworkDeviceWaitOptions = {},
): Promise<QwenworkDeviceTokenResponse> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const interval = options.intervalMs ?? QWENWORK_DEVICE_POLL_INTERVAL_MS
  const timeout = options.timeoutMs ?? QWENWORK_DEVICE_POLL_TIMEOUT_MS
  const now = options.now ?? Date.now
  const deadline = now() + timeout
  while (now() < deadline) {
    const result = await pollQwenworkDeviceTokenOnce(flow, fetchImpl)
    if (result.status === 'done') return result.tokens
    await sleep(interval)
  }
  throw new Error(
    'qwenwork: 登录超时（授权链接一次性，已失效）—— 请重新点击「添加账号」获取新链接',
  )
}

// ===== 响应 → 凭据 =====

/** ISO / 毫秒时间戳归一化为毫秒（0 = 未知）。 */
function toEpochMs(value: string | number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

/**
 * 把设备码登录响应映射为渠道凭据。
 *
 * - `machine_id` 用**本次 flow 的 machineId**（授权时的设备身份，chat 阶段作为
 *   `Cosy-MachineId` 透传 —— 与服务端绑定的登录设备保持一致）。
 * - `refresh_expires_at`：设备码响应不单独下发 refresh 过期时间，按与
 *   access 同寿命处理（实测均为 7 天）；拿不到就写 0（未知）。
 */
export function qwenworkDeviceCredential(
  flow: QwenworkDeviceFlow,
  tokens: QwenworkDeviceTokenResponse,
): QwenworkCredential {
  const expiresAt = toEpochMs(tokens.expires_at)
    || (typeof tokens.expires_in === 'number' && tokens.expires_in > 0
      ? Date.now() + tokens.expires_in * 1000
      : 0)
  return {
    access_token: tokens.token,
    refresh_token: tokens.refresh_token ?? '',
    expires_at: expiresAt,
    refresh_expires_at: expiresAt,
    uid: tokens.user_id ?? '',
    name: tokens.user_name ?? '',
    email: '',
    machine_id: flow.machineId,
    source: 'device-flow',
  }
}
