/**
 * 千问办公渠道 —— 本机凭据加解密。
 *
 * ## 三件事
 *
 * 1. **身份材料加密**（`encryptUserMaterial`）：随机 16 位 hex key →
 *    AES-128-CBC（IV = key 本身，PKCS7）加密用户信息；再用官方 RSA 公钥
 *    （PKCS#1 v1.5）加密 key。产物喂给 WASM `qodercontext_new` 的
 *    `user_info`。与官方 asar `generateAuthToken` 逐字段对齐。
 * 2. **auth-v2.dat 解密**（macOS 路径）：`v10` 前缀 + Keychain
 *    `QwenWorkCN Safe Storage` 口令 → PBKDF2-SHA1("saltysalt", 1003, 16B)
 *    → AES-128-CBC（IV = 16 个空格）→ PKCS5 去填充 → JSON。
 * 3. **Keychain 读取**：`security find-generic-password -s <service> -w`。
 *    Windows DPAPI 路径（Local State → AES-256-GCM）待实测后补，
 *    先走明文 JSON 回退与粘贴导入。
 */

import { execFile } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  publicEncrypt,
  randomUUID,
  constants as cryptoConstants,
} from 'node:crypto'
import { promisify } from 'node:util'
import { QWENWORK_RSA_PUBLIC_KEY_PEM } from './qwenwork.js'

const execFileAsync = promisify(execFile)

// ===== 身份材料（喂给 WASM 的 user_info） =====

/** 加密后的用户身份材料。 */
export interface QwenworkUserMaterial {
  /** AES 加密后的用户信息（base64）。 */
  info: string
  /** RSA 加密后的 AES key（base64）。 */
  key: string
  /** 明文 uid（`Cosy-User` 头用）。 */
  uid: string
}

/** `qodercontext_new` 的 user_info JSON 结构。 */
export interface QwenworkWasmUserInfo {
  uid: string
  encrypt_user_info: string
  key: string
  organization_id: string
}

/** 官方口径：`randomUUID().replace(/-/g, '').substring(0, 16)`。 */
function newAesKeyChars(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

/** AES-128-CBC（key = 16 ASCII 字符，IV = key 自身，PKCS7）→ base64。 */
function aesCbcEncryptBase64(plaintext: string, keyChars: string): string {
  const key = Buffer.from(keyChars, 'utf-8')
  if (key.length !== 16) throw new Error(`AES key 必须是 16 字节，实际 ${key.length}`)
  const cipher = createCipheriv('aes-128-cbc', key, key)
  return Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]).toString('base64')
}

/** RSA-PKCS1 v1.5 加密 AES key → base64。 */
function rsaEncryptKeyBase64(keyChars: string): string {
  const encrypted = publicEncrypt(
    {
      key: QWENWORK_RSA_PUBLIC_KEY_PEM,
      padding: cryptoConstants.RSA_PKCS1_PADDING,
    },
    Buffer.from(keyChars, 'utf-8'),
  )
  return encrypted.toString('base64')
}

/** 构造喂给 `qodercontext_new` 的用户身份材料。 */
export function encryptUserMaterial(options: {
  uid: string
  name: string
  email: string
  accessToken: string
}): QwenworkUserMaterial {
  const keyChars = newAesKeyChars()
  const payload = JSON.stringify({
    uid: options.uid || '',
    aid: '',
    name: options.name || '',
    email: options.email || '',
    security_oauth_token: options.accessToken || '',
  })
  return {
    info: aesCbcEncryptBase64(payload, keyChars),
    key: rsaEncryptKeyBase64(keyChars),
    uid: options.uid || '',
  }
}

/** 组装 `qodercontext_new` 的 `user_info` JSON 字符串。 */
export function buildQwenworkUserInfoJson(material: QwenworkUserMaterial): string {
  return JSON.stringify({
    uid: material.uid,
    encrypt_user_info: material.info,
    key: material.key,
    organization_id: '',
  })
}

// ===== Chromium macOS `v10` blob（Electron safeStorage） =====

/** PBKDF2-SHA1("saltysalt", 1003) → 16 字节 key；IV 恒为 16 个空格。 */
function chromiumMacKey(keychainPassword: string): Buffer {
  return pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1')
}

const CHROMIUM_MAC_IV = Buffer.alloc(16, 0x20)

/** 解密 macOS Chromium `v10` blob → UTF-8 明文。 */
export function decryptChromiumMacV10(blob: Buffer, keychainPassword: string): string {
  if (blob.subarray(0, 3).toString('ascii') !== 'v10') {
    throw new Error('auth-v2.dat 不是 Chromium v10 格式')
  }
  const decipher = createDecipheriv('aes-128-cbc', chromiumMacKey(keychainPassword), CHROMIUM_MAC_IV)
  const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()])
  return plain.toString('utf-8')
}

/** 加密回写（`v10` 前缀；仅当实现了「刷新后回写官方文件」时使用）。 */
export function encryptChromiumMacV10(plaintext: string, keychainPassword: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', chromiumMacKey(keychainPassword), CHROMIUM_MAC_IV)
  return Buffer.concat([
    Buffer.from('v10', 'ascii'),
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ])
}

/** 钥匙串服务名（Electron 以 `productName` 命名；实测就是 `QwenWorkCN`）。 */
export const QWENWORK_KEYCHAIN_SERVICE = 'QwenWorkCN Safe Storage'

/** 读取钥匙串口令；读不到（未装/未授权）返回 `undefined`。 */
export async function readKeychainPassword(
  service = QWENWORK_KEYCHAIN_SERVICE,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-w'], {
      timeout: 10_000,
    })
    const value = stdout.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * 解密 `auth-v2.dat` 的兼容入口：
 * - 明文 JSON（客户端降级模式）直接解析；
 * - `v10` blob 走 macOS 钥匙串路径。
 */
export function decryptQwenworkAuthFile(
  blob: Buffer,
  keychainPassword: string | undefined,
): unknown {
  if (blob.subarray(0, 1).toString('ascii') === '{') {
    return JSON.parse(blob.toString('utf-8'))
  }
  if (keychainPassword === undefined) {
    throw new Error('auth-v2.dat 已加密但拿不到钥匙串口令（QwenWorkCN Safe Storage）')
  }
  return JSON.parse(decryptChromiumMacV10(blob, keychainPassword))
}
