/**
 * 千问办公渠道 —— 认证服务。
 *
 * ## 登录模型（两条，后者为「给别人用」的主路径）
 *
 * 1. **本机导入制**（v1）：从本机官方客户端 `auth-v2.dat` 解密导入
 *    （`qwenwork-store.ts`，macOS 需钥匙串授权）或粘贴 JSON。只适合自己用。
 * 2. **设备码网页登录**（`startDeviceLogin`，见 `qwenwork-device.ts`）：
 *    复刻官方客户端的 OAuth Device Flow —— 用户在自己浏览器登录**自己的**
 *    阿里账号即可，不装客户端、不碰钥匙串。多用户各自带账号（BYO）。
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
  createQwenworkDeviceFlow,
  qwenworkDeviceCredential,
  waitForQwenworkDeviceLogin,
} from './qwenwork-device.js'
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

/**
 * 自动续期提前量：**12 小时**。
 *
 * 千问办公 access_token 寿命 7 天（设备码登录与续期响应一致），调度循环是
 * 30 分钟一轮 —— 用共享的 1 小时提前量只剩 ~2 次机会，赶上次重启就断供。
 * 12 小时窗口在「每 30 分钟一轮」下有 24 次机会，且每 6.5 天才真正换一次
 * refresh_token，不会频繁轮换。
 */
const QWENWORK_REFRESH_LEAD_MS = 12 * 60 * 60 * 1000

/** 续期「终态」判据：服务端明确拒绝 refresh_token 时才降级标记。 */
const QWENWORK_REFRESH_TERMINAL_RE =
  /invalid[_ ]grant|refresh[_ ]token.*(invalid|expired|revoked)|unauthorized|401/i

/** `refreshAll` 所需的最小账号池能力（收窄依赖，便于单测替身）。 */
export interface QwenworkPool {
  listAccounts(provider: string): Promise<
    ReadonlyArray<{
      id: string
      credentialRef: string
      refreshable?: boolean
      expiresAt?: number
    }>
  >
  updateAccount(
    id: string,
    patch: { expiresAt?: number; refreshable?: boolean },
  ): Promise<void>
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

  /** 读取凭据（默认读默认 ref；可指定账号自己的 ref）。 */
  async load(refName: string = this.credentialRefName): Promise<QwenworkCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
    if (resolved === undefined) return undefined
    try {
      return JSON.parse(resolved.value) as QwenworkCredential
    } catch {
      return undefined
    }
  }

  private async save(
    credential: QwenworkCredential,
    refName: string = this.credentialRefName,
  ): Promise<void> {
    await this.ctx.credentials.set(
      credentialRef(refName),
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
   * 发起**设备码网页登录**（官方客户端同款 OAuth Device Flow）。
   *
   * 立刻返回 `loginUrl`（前端要在这个调用返回后马上 `window.open`，否则会被
   * 弹窗拦截），授权与轮询在后台跑完 —— 与 Qoder / CodeArts 两步式同因。
   *
   * ⚠️ `loginUrl` **一次性**：生成后任何人先访问一次，链接即被服务端消费
   *（`DEVICE_FLOW_REPLAYED`）。所以**不要**在这里做「连通性预检」。
   *
   * `refName` 指定凭据落到哪个 ref —— 多账号场景由 `account.create` 传入
   * `QWENWORK_ACCOUNT_XXX`，各账号互不覆盖（BYO：每人带自己的账号）。
   */
  async startDeviceLogin(refName?: string): Promise<{
    loginUrl: string
    result: Promise<QwenworkCredential>
  }> {
    const targetRef = refName ?? this.credentialRefName
    const flow = createQwenworkDeviceFlow()
    const result = (async (): Promise<QwenworkCredential> => {
      const tokens = await waitForQwenworkDeviceLogin(flow, {
        fetchImpl: this.fetchImpl,
      })
      const credential = qwenworkDeviceCredential(flow, tokens)
      await this.save(credential, targetRef)
      return credential
    })()
    // 后台链路自己吞掉 rejection 的「未处理」告警：由调用方通过 result 处理。
    result.catch(() => {})
    return { loginUrl: flow.authUrl, result }
  }

  /**
   * 续期：用 refresh_token 换新 access_token 并写回。
   *
   * ⚠️ refresh_token 已过期（`refresh_expires_at` 先于 access_token 过期是
   * 实测常态）会抛错 —— 此时 access_token 往往仍可用（对话不受影响），
   * 仅续期与「过期后续期」不可用，需重新走设备码登录。
   */
  async refresh(refName: string = this.credentialRefName): Promise<void> {
    const credential = await this.load(refName)
    if (credential === undefined) return
    const next = await refreshQwenworkCredential(credential, this.fetchImpl)
    await this.save({
      ...credential,
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      expires_at: next.expires_at,
      refresh_expires_at: next.refresh_expires_at,
    }, refName)
  }

  /**
   * 按账号续期（`account.refresh` 用）：续期该账号自己的 ref，并把新
   * `expires_at` 写回账号池 —— 否则 UI 一直显示「已过期」而实际可用。
   */
  async refreshAccountCredential(
    refName: string,
    pool: QwenworkPool,
    accountId: string,
  ): Promise<void> {
    await this.refresh(refName)
    const next = await this.load(refName)
    await pool.updateAccount(accountId, {
      expiresAt: next === undefined ? undefined : next.expires_at,
    })
  }

  /** 领取每日赠分（临期先续期一次；续期失败不阻断 —— access_token 仍可用）。 */
  async claimDaily(refName: string = this.credentialRefName): Promise<QwenworkClaimResult> {
    let credential = await this.load(refName)
    if (credential === undefined) {
      return { ok: false, claimed: false, alreadyClaimed: false, credit: 0, message: '尚未导入千问办公凭据' }
    }
    if (isQwenworkExpired(credential)) {
      try {
        await this.refresh(refName)
        credential = await this.load(refName)
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
  async status(refName: string = this.credentialRefName): Promise<Record<string, unknown>> {
    const credential = await this.load(refName)
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

  /**
   * **自动续期调度入口**（由 `index.ts` 的 30 分钟全局循环调用）。
   *
   * ## 为什么不复用 `shouldRefreshNow` 的 1 小时提前量
   *
   * 那个提前量是给 1~3 小时寿命的 provider（cline / codearts / raccoon）用的；
   * 千问办公的 access_token 是 **7 天**寿命，按 1 小时提前量在「30 分钟一轮」
   * 下只有约 2 次机会，一旦这两轮赶上服务重启就断供。这里用 **12 小时**
   * 提前量：每轮命中后换新的 7 天 token，下次要到 6.5 天后才再命中，
   * 既不会频繁轮换 refresh_token，又留足重试窗口。
   *
   * ## 失败语义（与其它 provider 对齐）
   *
   * - 单账号异常**不中断整批**；
   * - 凭据缺失 / 无 refresh_token → 只把池里 `refreshable` 对账成 false；
   * - 续期被服务端明确拒绝（refresh_token 失效）→ 标 `refreshable:false`
   *   并提示重新「添加账号」，**不清空凭据**（access_token 往往仍可用）；
   * - 网络类失败 → 保留 `refreshable`，下一轮自然重试。
   */
  async refreshAll(pool: QwenworkPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      try {
        const credential = await this.load(entry.credentialRef)
        if (credential === undefined) {
          if (entry.refreshable === true) {
            await pool.updateAccount(entry.id, { refreshable: false })
          }
          continue
        }
        const hasRefresh = credential.refresh_token.length > 0
        if (entry.refreshable !== hasRefresh) {
          await pool.updateAccount(entry.id, { refreshable: hasRefresh })
        }
        if (!hasRefresh) continue
        const expiresAt = credential.expires_at
        if (expiresAt > 0 && expiresAt - Date.now() > QWENWORK_REFRESH_LEAD_MS) {
          // 还没到续期窗口：只做一次轻量对账（凭据换了但池里没跟上时修回来）。
          if (entry.expiresAt !== expiresAt) {
            await pool.updateAccount(entry.id, { expiresAt })
          }
          continue
        }
        await this.refreshAccountCredential(entry.credentialRef, pool, entry.id)
        this.ctx.logger?.info?.(
          `[${this.product.id}] 账号 ${entry.id} 自动续期成功（下一个 7 天窗口）`,
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.ctx.logger?.warn?.(
          `[${this.product.id}] 账号 ${entry.id} 自动续期失败：${detail}`,
        )
        // 终态（refresh_token 失效 / 账号被踢）才降级标记；网络类错误留待下轮重试。
        if (QWENWORK_REFRESH_TERMINAL_RE.test(detail) && entry.refreshable !== false) {
          await pool.updateAccount(entry.id, { refreshable: false }).catch(() => {})
          this.ctx.logger?.warn?.(
            `[${this.product.id}] 账号 ${entry.id} 的 refresh_token 已失效 —— 请在面板重新「添加账号」走一次网页授权`,
          )
        }
      }
    }
  }
}
