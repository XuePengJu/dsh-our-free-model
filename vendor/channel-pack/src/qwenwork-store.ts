/**
 * 千问办公渠道 —— 本机凭据发现与导入。
 *
 * ## v1 支持的三条来源
 *
 * 1. **官方桌面客户端（macOS）**：`~/Library/Application Support/QwenWorkCN/auth-v2.dat`
 *    （Electron safeStorage，`v10`，钥匙串 `QwenWorkCN Safe Storage`）。
 *    ⚠️ 钥匙串访问可能弹授权框 —— 由调用方决定何时触发（导入是显式动作）。
 * 2. **明文 JSON 回退**：`auth-v2.dat.json`（客户端 safeStorage 不可用时的
 *    降级落盘）或整份明文 `auth-v2.dat`（以 `{` 开头）。
 * 3. **粘贴 JSON**：官方文档形状（扁平 token/refreshToken/… 或
 *    `{auth:{accessToken,…}, user:{…}}` 嵌套）。
 *
 * Windows DPAPI（`Local State` encrypted_key → AES-256-GCM）待实测后补；
 * 补齐前 Windows 用户走粘贴导入。
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  decryptQwenworkAuthFile,
  readKeychainPassword,
} from './qwenwork-crypto.js'
import {
  parseQwenworkDocument,
  qwenworkIsoToMs,
  qwenworkJwtExpMs,
  type QwenworkAuthDocument,
  type QwenworkCredential,
} from './qwenwork.js'

/** 官方客户端数据目录（macOS）。 */
export function qwenworkUserDataDir(): string {
  const override = process.env.QWENWORK_USER_DATA_DIR?.trim()
  if (override) return override
  return join(homedir(), 'Library', 'Application Support', 'QwenWorkCN')
}

/** 显式指定的凭据文件（测试/多目录场景）。 */
function qwenworkAuthFileOverride(): string | undefined {
  return process.env.QWENWORK_AUTH_FILE?.trim() || undefined
}

/** 解析「粘贴 JSON」为凭据（兼容扁平 / `{auth, user}` 嵌套两种形状）。 */
export function parseQwenworkPaste(body: unknown): QwenworkCredential {
  if (typeof body !== 'object' || body === null) {
    throw new Error('千问办公凭据必须是 JSON 对象')
  }
  const raw = body as Record<string, unknown>
  const auth = typeof raw.auth === 'object' && raw.auth !== null
    ? raw.auth as Record<string, unknown>
    : {}
  const user = typeof raw.user === 'object' && raw.user !== null
    ? raw.user as Record<string, unknown>
    : {}

  const token = firstString(
    raw.token, raw.access_token, raw.device_token, auth.accessToken, auth.token,
  )
  const refreshToken = firstString(raw.refreshToken, raw.refresh_token, auth.refreshToken)
  if (token === '' && refreshToken === '') {
    throw new Error('千问办公凭据需要 token / refreshToken 至少其一')
  }
  const uid = firstString(
    user.id, user.uid, raw.uid, raw.user_id,
  )
  const access = token !== '' ? token : refreshToken
  return {
    access_token: access,
    refresh_token: refreshToken,
    expires_at: qwenworkIsoToMs(firstString(raw.expiresAt, raw.expires_at, auth.expiresAt))
      || qwenworkJwtExpMs(access),
    refresh_expires_at: qwenworkIsoToMs(
      firstString(raw.refreshTokenExpiresAt, raw.refresh_expires_at, auth.refreshExpiresAt),
    ),
    uid,
    name: firstString(user.name, raw.nickname, raw.name),
    email: firstString(user.email, raw.email),
    machine_id: firstString(raw.loginDeviceId, raw.machine_id),
    source: 'paste',
  }
}

/** 依序读官方客户端凭据文件；都没有返回 `undefined`。 */
export async function readLocalQwenworkCredential(): Promise<QwenworkCredential | undefined> {
  const dir = qwenworkUserDataDir()
  const candidates: string[] = []
  const override = qwenworkAuthFileOverride()
  if (override) candidates.push(override)
  // ⚠️ 顺序照 Buddy2api 的实测教训：auth-v2.dat 优先；legacy auth.dat 是旧的
  // device-token 文件，同 uid 但导入它会覆盖可用会话导致 401 —— 只在 v2 缺席时兜底。
  candidates.push(join(dir, 'auth-v2.dat'), join(dir, 'auth.dat'), join(dir, 'auth-v2.dat.json'))
  for (const path of candidates) {
    try {
      if (!(await stat(path)).isFile()) continue
      const blob = await readFile(path)
      let document: QwenworkAuthDocument
      if (blob.subarray(0, 1).toString('ascii') === '{') {
        document = JSON.parse(blob.toString('utf-8')) as QwenworkAuthDocument
      } else {
        const password = await readKeychainPassword()
        document = decryptQwenworkAuthFile(blob, password) as QwenworkAuthDocument
      }
      const credential = parseQwenworkDocument(document)
      credential.source = path
      return credential
    } catch {
      // 单个候选失败（不存在 / 未授权 / 解密失败）→ 尝试下一个
      continue
    }
  }
  return undefined
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}
