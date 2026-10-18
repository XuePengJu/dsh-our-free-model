/**
 * 千问办公渠道 —— 认证服务。
 *
 * ## v1 登录模型：**本机导入制**
 *
 * 千问办公没有可直接对接的 OAuth 网页流（桌面客户端私有协议 + 设备指纹），
 * 故与其它渠道的「浏览器登录」不同：凭据来自**本机官方客户端**
 * （`auth-v2.dat` 解密，见 `qwenwork-store.ts`）或粘贴 JSON。
 * 官方客户端仍是登录与续期的兜底 —— refresh_token 过期时提示用户去客户端
 * 重新登录再导入（与 Buddy2api 同一口径）。
 *
 * 续期成功后会把新 token **写回默认凭据 ref**；不回写官方客户端文件
 * （避免与客户端自身的刷新竞态 —— 官方客户端登录态仍是用户的主会话）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  parseQwenworkPaste,
  readLocalQwenworkCredential,
} from './qwenwork-store.js'
import {
  claimQwenworkDailyCredit,
  refreshQwenworkCredential,
  type QwenworkClaimResult,
} from './qwenwork-credits.js'
import { isQwenworkExpired, type QwenworkCredential } from './qwenwork.js'
import type { QwenworkProduct } from './qwenwork-product.js'
import { QWENWORK } from './qwenwork-product.js'

/** QwenworkAuth 构造选项。 */
export interface QwenworkAuthOptions {
  product?: QwenworkProduct
  /** 测试注入 fetch。 */
  fetchImpl?: typeof fetch
}

/** 千问办公认证服务（凭据导入 / 续期 / 每日赠分）。 */
export class QwenworkAuth extends Service {
  readonly product: QwenworkProduct
  readonly credentialRefName: string

  constructor(ctx: Context, private readonly options: QwenworkAuthOptions = {}) {
    const product = options.product ?? QWENWORK
    super(ctx, `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /** 读取当前凭据（默认 ref）。 */
  async load(): Promise<QwenworkCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (resolved === undefined) return undefined
    try {
      return JSON.parse(resolved.value) as QwenworkCredential
    } catch {
      return undefined
    }
  }

  private async save(credential: QwenworkCredential): Promise<void> {
    await this.ctx.credentials.set(
      credentialRef(this.credentialRefName),
      JSON.stringify(credential),
    )
  }

  /**
   * 从本机官方客户端导入凭据。
   *
   * ⚠️ macOS 首次调用可能弹钥匙串授权框（`security` 读
   * `QwenWorkCN Safe Storage`）—— 这是预期行为，属显式导入动作。
   */
  async importLocal(): Promise<QwenworkCredential> {
    const credential = await readLocalQwenworkCredential()
    if (credential === undefined) {
      throw new Error(
        'qwenwork: 本机未找到千问办公凭据 —— 请确认官方客户端已安装并登录'
        + `（${'~/Library/Application Support/QwenWorkCN/auth-v2.dat'}），或改用粘贴导入`,
      )
    }
    await this.save(credential)
    return credential
  }

  /** 从粘贴的 JSON 导入凭据。 */
  async importJson(text: string): Promise<QwenworkCredential> {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('qwenwork: 粘贴内容不是合法 JSON')
    }
    const credential = parseQwenworkPaste(parsed)
    await this.save(credential)
    return credential
  }

  /**
   * 续期：用 refresh_token 换新 access_token 并写回。
   *
   * ⚠️ refresh_token 已过期（`refresh_expires_at` 先于 access_token 过期是
   * 实测常态）会抛错 —— 此时 access_token 往往仍可用（对话不受影响），
   * 仅续期与「过期后续期」不可用，需官方客户端重新登录。
   */
  async refresh(): Promise<void> {
    const credential = await this.load()
    if (credential === undefined) return
    const next = await refreshQwenworkCredential(credential, this.fetchImpl)
    await this.save({
      ...credential,
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      expires_at: next.expires_at,
      refresh_expires_at: next.refresh_expires_at,
    })
  }

  /** 领取每日赠分（临期先续期一次；续期失败不阻断 —— access_token 仍可用）。 */
  async claimDaily(): Promise<QwenworkClaimResult> {
    let credential = await this.load()
    if (credential === undefined) {
      return { ok: false, claimed: false, alreadyClaimed: false, credit: 0, message: '尚未导入千问办公凭据' }
    }
    if (isQwenworkExpired(credential)) {
      try {
        await this.refresh()
        credential = await this.load()
      } catch {
        // access_token 未过期时仍可领取；真过期会在 claim 里拿到 401
      }
    }
    if (credential === undefined) {
      return { ok: false, claimed: false, alreadyClaimed: false, credit: 0, message: '凭据丢失' }
    }
    return claimQwenworkDailyCredit(credential, this.fetchImpl)
  }

  /** 凭据摘要（RPC/展示用；token 打码）。 */
  async status(): Promise<Record<string, unknown>> {
    const credential = await this.load()
    if (credential === undefined) return { loggedIn: false }
    return {
      loggedIn: true,
      uid: credential.uid,
      name: credential.name,
      source: credential.source.startsWith('/') ? 'local' : credential.source,
      expiresAt: credential.expires_at,
      refreshExpiresAt: credential.refresh_expires_at,
      expired: isQwenworkExpired(credential),
    }
  }
}
