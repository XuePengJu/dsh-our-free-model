import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { registerCodeArtsLlm, PROVIDER as CODEARTS_PROVIDER } from './llm-adapter.js'
import { registerBuddyLlm } from './buddy-adapter.js'
import { registerLobsteraiLlm } from './lobsterai-adapter.js'
import { registerQoderLlm } from './qoder-adapter.js'
import { registerTraeLlm } from './trae-adapter.js'
import { registerClineLlm } from './cline-adapter.js'
import { registerLoomyLlm, parseLoomyRemoteModels } from './loomy-adapter.js'
import { registerRaccoonLlm } from './raccoon-adapter.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from './service.js'
import { BUDDY_CREDENTIAL_REF, BuddyAuth, createPoolRefresh } from './buddy-auth.js'
import { LobsteraiAuth } from './lobsterai-auth.js'
import { QoderAuth } from './qoder-auth.js'
import { TraeAuth } from './trae-auth.js'
import { ClineAuth } from './cline-auth.js'
import { LoomyAuth } from './loomy-auth.js'
import { RaccoonAuth } from './raccoon-auth.js'
import { LOOMY } from './loomy-product.js'
import { LoomyBalanceSelector } from './loomy-balance-selector.js'
import { RACCOON } from './raccoon-product.js'
import { ZcodeAuth } from './zcode-auth.js'
import { registerZcodeLlm } from './zcode-adapter.js'
import { ZCODE } from './zcode-product.js'
import { ZCODE_CAPTCHA_FALLBACK } from './zcode-captcha.js'
import type { CarrierOutcome } from './captcha-carrier.js'
import type { ZcodeCredential } from './zcode.js'
import { AccountPool, allAccountsRateLimitedForModel } from './account-pool.js'
import { hasLegacyNamespaceRegistration, settingsOf, suppressAutoSettingsPage } from './settings-compat.js'
import type { ImageRequestTarget } from './image-budget.js'
import { buildRaccoonNickname, registerChannelPackRpc } from './channel-pack-rpc.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from './product.js'
import { mountOpenAiGateway } from './openai-gateway/index.js'
import { installLoopResume } from './loop-recovery.js'
import {
  attachTokenLedgerStore,
  reportLedgerAccount,
} from './token-ledger.js'
import { createTokenLedgerStore } from './token-ledger-store.js'
import { buddyExpiringWindowDays } from './buddy-balance-rank.js'
import { BuddyBalanceSelector, pickBuddyAccount } from './buddy-balance-selector.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { QODER, QODER_CN } from './qoder-product.js'
import { TRAE } from './trae-product.js'
import { CLINE } from './cline-product.js'
import { configureDeadModelStore, withDeadModelPruning } from './dead-model-store.js'
import type { CodeArtsCredential, BuddyCredential } from './types.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { QoderCredential } from './qoder.js'
import type { TraeCredential } from './trae.js'
import type { ClineCredential } from './cline.js'
import type { LoomyCredential } from './loomy.js'
import type { RaccoonCredential } from './raccoon.js'
import { MinimaxAuth } from './minimax-auth.js'
import { registerMinimaxLlm } from './minimax-adapter.js'
import { MINIMAX } from './minimax-product.js'
import type { MinimaxCredential } from './minimax.js'
import { QwenworkAuth } from './qwenwork-auth.js'
import { registerQwenworkLlm } from './qwenwork-adapter.js'
import { QWENWORK } from './qwenwork-product.js'
import type { QwenworkCredential } from './qwenwork.js'
import { GeminiAuth } from './gemini-auth.js'
import { registerGeminiLlm } from './gemini-adapter.js'
import { GEMINI } from './gemini.js'
import type { GeminiCredential } from './gemini.js'
import { createGeminiSigStore } from './gemini-sigstore.js'
import { registerOpencodeLlm } from './opencode-adapter.js'
// ⚠️ opencode 的 RPC 由 `channel-pack-rpc.ts` 的 handleMethod 统一分派
// （它调 handleOpencodeRpc），本文件**不再**单独注册端点 —— 详见
// `opencode-rpc.ts` 模块头「为什么是被主 switch 调用」。
import {
  ensureDefaultAnonymousSlot, listIdentitySlots, type PoolEntrySnapshot,
} from './opencode-auth.js'
import { OPENCODE } from './opencode-product.js'
import { deriveProjectId, opencodeUserAgent, opencodeUserAgentForVersion } from './opencode.js'
import { primeOpencodeCapabilities, refreshOpencodeCapabilities } from './opencode-capability.js'
import { closeAllProxyDispatchers } from './opencode-proxy.js'
import { createChannelFetch } from './channel-fetch.js'
import { attachDirectFetch, createDirectFetch, type SignedChannelOutlet } from './direct-fetch.js'
export { directFetch, directLane, createDirectFetch, closeDirectFetch } from './direct-fetch.js'
export { createChannelFetch, parseWindowsProxy, channelProxyBypassed } from './channel-fetch.js'
import { execFile } from 'node:child_process'

/**
 * 懒加载的 OpenCode UA：首个请求要发时才探测本机 opencode 版本，探测一次即缓存。
 *
 * ⚠️ 拿不到**不阻塞、不抛错**，回退 `OPENCODE.defaultUserAgent`：UA 只是一个伪装
 * 维度，服务端并未校验其真实性（opencode2dsh 实测），不值得为此延迟启动。
 * 探测最多等 2 秒；本机没装 opencode 是**正常情况**（匿名通道照样能用）。
 * ⚠️ 用 `execFile` 而非 `exec`：**不经过 shell**，参数不会被解释；带
 * `windowsHide` 免得在 Windows 上闪一个黑框。
 * ⚠️ 缓存 Promise 而非结果：并发首请求只会 spawn 一次探测进程。
 */
function lazyOpencodeUserAgent(): () => string {
  let pending: Promise<string> | undefined
  return () => {
    pending ??= new Promise<string>((resolve) => {
      execFile('opencode', ['--version'], { timeout: 2000, windowsHide: true }, (_err, stdout) => {
        resolve(typeof stdout === 'string' ? stdout : '')
      })
    })
      .then((out) => {
        const version = out.match(/(\d+\.\d+\.\d+)/)?.[1]
        // ⚠️ 探测值必须转成 **v2 形状**（`opencode/latest/<version>/cli`）：
        // 旧实现直接拼 `opencode/<version>` 是 v1 形状，v2 门禁一律 403
        // （见 `opencode.ts` 模块头）。
        return opencodeUserAgentForVersion(version) ?? OPENCODE.defaultUserAgent
      })
      .catch(() => OPENCODE.defaultUserAgent)
    // 同步取值：缓存命中时立刻有值；未命中时用产品默认（不阻塞首个请求）。
    let cached = OPENCODE.defaultUserAgent
    void pending.then((ua) => { cached = ua })
    return cached
  }
}

/**
 * 拉取 Zen 模型目录的超时（毫秒）。
 *
 * ⚠️ 桌面版实测：到 `opencode.ai` 的 fetch 可能**永不 settle**（宿主网络
 * 异常），而 `loadOpencodeCatalog` 的兜底分支只有在内层 Promise **结束**
 * 后才可能执行。挂死时模型列表与用量徽标会同时空白（用户报障 2026-10-02）。
 * 8 秒足够覆盖正常路径（实测首字节 720ms 量级），又不会让 UI 干等太久。
 */
const OPENCODE_CATALOG_TIMEOUT_MS = 8_000

export const name = 'codearts-auth'
// `connection` 刻意不列入静态 inject：它只由 Web bundle（dsh-client-connection）
// 提供，headless/CLI profile 里并不存在。静态 inject 会让本插件在那些 profile
// 里永久 pending，进而让整个 profile 以
// "plugin tree failed to load: 1 entry did not activate" 启动失败
// —— chicheng-cron 的 skill/agent 任务正是通过 `dsh --profile headless` 运行的，
// 会因此全部 exit 1。Channel Pack 的 RPC 端点在 Web 下通过 apply 内的可选注入挂载，
// 其余 profile 只是不注册该端点。
export const inject = ['credentials', 'commands', 'llm']

/**
 * 插件 Config schema。
 *
 * ⚠️ **DSH 0.1.7-rc.1 起，settings 表单的命名空间就是 profile 条目 id**
 * （本插件的条目 id 是 `codearts-auth`），且只投影本条目 Config 中标记了
 * `.volatile()` 的字段。因此这里保留一个 `providers` 映射：
 * - **历史**：它曾是各 provider 用 `registerConfigurableProviders({ settingsNs })`
 *   声明时的落地位置，模型设置页据此把它们判定为「已配置」（判据见
 *   `dsh-client-ui-settings-models` 的 `configured`）。**2026-10-01 起本插件不再
 *   声明可配置 provider**（见 `llm-register-compat.ts` 模块头），该映射因此没有
 *   消费者，保留它只为不改变 `settings.describe()` 的既有形状；
 * - 本插件的凭据与账号管理**不**走这里（那是 Channel Pack 的账号池 +
 *   `ctx.credentials`），故该字段只承接一个宽松映射，不参与业务读取。
 *
 * 必须是 schemastery schema：`SettingsForms.describe()` 会对每个注册项调用
 * `schema.toJSON()`，传入裸函数（`(value) => ...`）会让它抛
 * `TypeError: ... .toJSON is not a function`，进而使所有依赖 settings 的界面
 * （模型设置页、sidebar 的 settings.get/shell.get）全部失败。
 */
export const Config = Schema.object({
  providers: Schema.dict(Schema.any()).default({}).volatile(),
})

/**
 * 注册 provider 配置 namespace（**仅老契约需要**）。
 *
 * - **≤0.1.6**：`ctx.settings` 允许插件注册任意 namespace，六个 provider 各占
 *   一个（`llm-buddy` / `llm-workbuddy` / ...）。注册缺失会让模型设置页在
 *   `refFor → deriveKeyRef(provider)` 处以
 *   `provider.toUpperCase is not a function` 崩溃，故注册后回读 `describe()` 自检。
 * - **0.1.7-rc.1**：settings 换成 `SettingsForms`，**没有 `register`**，命名
 *   空间只能是 profile 条目 id —— 此时不再（也无法）注册。这里刻意**静默跳过**：
 *   旧实现在这条分支上会打一条误导性的
 *   「settings 服务不可用」告警（启动日志实证）。
 *
 * ⚠️ **2026-10-01 起各 provider 不再声明为可配置 provider**（`settingsNamespaceFor`
 * 因此没有调用方），模型设置页不再有这些 namespace 的消费者 —— 这份注册此后只影响
 * ≤0.1.6 的老契约 profile，属遗留行为，本次未一并删除。
 */
function registerProviderSettings(ctx: Context, ...namespaces: string[]): void {
  const settings = settingsOf(ctx)
  if (!hasLegacyNamespaceRegistration(settings) || settings?.register === undefined) return
  for (const ns of namespaces) {
    try {
      settings.register(ns, Config)
    } catch (error) {
      ctx.logger.warn(`[codearts-auth] settings namespace "${ns}" 注册失败: ${String(error)}`)
    }
  }
  // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
  // 注意：describe() 会遍历所有已注册 namespace 并调用各自 schema 的
  // toJSON()/redactSecrets()，任一注册项的 schema 不合规都会让整条调用抛错。
  // 因此这里必须把异常打出来，而不是静默吞掉。
  try {
    const descriptors = settings.describe?.({ redactSecrets: true }) ?? []
    const registered = descriptors.map(v => v.ns)
    const missing = namespaces.filter(ns => !registered.includes(ns))
    if (missing.length > 0) {
      ctx.logger.warn(`[codearts-auth] provider namespace 未生效: ${missing.join(', ')}`)
    }
    ctx.logger.info(`[codearts-auth] settings.describe ok, namespaces: ${registered.join(', ')}`)
  } catch (error) {
    ctx.logger.error(
      `[codearts-auth] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: `
      + `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    )
  }
}

/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 *
 * 用 `ctx.get` 而非 `inject` —— 附件服务缺失时 provider 仍可正常加载，

 * 只是收到图片时报 UNSUPPORTED_CONTENT。三个 provider 共用本实现：
 * 两个 CodeBuddy 系产品（CodeBuddy / WorkBuddy）共用同一后端与协议；
 * LobsterAI 的图片形态同为 OpenAI 兼容的 `image_url` data URL
 * （2026-09-17 实测服务端接受并正确识别内容）。

 */
export function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string }> => {
    const attachments = ctx.get('attachments') as
      { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> } | undefined
    if (attachments?.readImage === undefined) {
      throw new Error(
        'codearts-auth: 附件服务（attachments）不可用，无法把图片内联进请求；'
        + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local。',
      )
    }
    const stored = await attachments.readImage(attachment as never)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }
}

/**
 * 图片「请求版本」桥接（issue !IKITT9）。
 *
 * 走 `ctx.attachments.readImageRequest(ref, target)`：由附件服务按目标尺寸与
 * 字节目标产出**确定性、可缓存**的缩放版本（alpha 走 WebP、不透明走 JPEG、
 * 85/75/60 质量阶梯），适配器只负责选目标。
 *
 * ⚠️ **任何不可用都返回 `undefined`，绝不抛错**，调用方据此回退原图。三种
 * 真实成因都必须容忍，否则「加上缩放」本身会变成新的故障源：
 *
 * 1. 宿主 profile 没装附件服务，或该版本没有 `readImageRequest`（老契约）；
 * 2. 附件后端明确拒绝投影（`ATTACHMENT_PROJECTION_UNSUPPORTED`）；
 * 3. 派生过程中的其它错误（缓存不可写、字节校验失败…）。
 *
 * 回退方向是刻意选 conservative 的一侧：宁可发一张大图（顶多触发网关的
 * 图片 token 上限），也不能因为「想缩图」而把一次本来能成功的请求打死。
 */
export function makeReadImageRequest(ctx: Context) {
  return async (
    attachment: unknown,
    target: ImageRequestTarget,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> => {
    const attachments = ctx.get('attachments') as {
      readImageRequest?: (
        ref: never,
        requestTarget: never,
      ) => Promise<{ data: Uint8Array; mediaType?: string; attachment?: { mediaType?: string } }>
    } | undefined
    if (attachments?.readImageRequest === undefined) return undefined
    try {
      const projected = await attachments.readImageRequest(attachment as never, target as never)
      const mediaType = projected.mediaType ?? projected.attachment?.mediaType
      if (mediaType === undefined) return undefined
      return { data: projected.data, mediaType }
    } catch (error) {
      // 只记日志、随后回退原图：缩放是优化，不是请求的前置条件。
      ctx.logger?.warn?.(
        '[channel-pack] 图片请求版本派生失败，回退原图：'
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
}

/** 注册 codeartsAuth 服务与 codearts LLM 路由（不注册斜杠命令）。 */
export function apply(ctx: Context, config: { disableOpencode?: boolean; outlet?: SignedChannelOutlet } = {}): void {
  const network = createChannelFetch({ outlet: config.outlet })
  const signedNetwork = createDirectFetch({ outlet: config.outlet })
  const detachSignedNetwork = attachDirectFetch(signedNetwork.fetch)
  ctx.effect(() => () => { detachSignedNetwork(); void signedNetwork.close() })
  ctx.effect(() => () => { void network.close() })
  // 本插件自带 Channel Pack 设置页，关闭 0.1.7 起由 Config schema 反渲染的自动表单
  // （老契约没有 configure()，静默跳过）。
  suppressAutoSettingsPage(ctx)

  // provider 配置命名空间的注册**只在老契约（≤0.1.6）下执行**：
  // 那时 `settings.register` 可用，十二个 namespace 分别对应 codearts 路由、
  // CodeBuddy（buddy）、WorkBuddy（workbuddy）、LobsterAI（lobsterai）、
  // Qoder（qoder / qodercn）、TRAE（trae）、Cline（cline）、Loomy（loomy）、
  // Raccoon（raccoon）、MiniMax（minimax）与 Zcode（zcode）。
  //
  // 0.1.7-rc.1 起 settings 换成 SettingsForms（无 register），命名空间只能是
  // profile 条目 id，故这里不做任何注册。
  //
  // ⚠️ 2026-10-01 起各 provider 已**不再**声明为可配置 provider，故这批 namespace
  // 在模型设置页上已无消费者（详见该函数头的说明）。
  registerProviderSettings(
    ctx, 'llm-buddy', 'llm-workbuddy', 'llm-codearts', 'llm-lobsterai',
    'llm-qoder', 'llm-qodercn', 'llm-trae', 'llm-cline', 'llm-loomy', 'llm-raccoon',
    'llm-minimax', 'llm-zcode', 'llm-gemini',
  )
  const service = new CodeArtsAuth(ctx, { fetcher: signedNetwork.fetch })
  const pool = new AccountPool(ctx)

  // 「已失效模型」剔除：注入 ctx 只为把日志接进 DSH logger 并复用同一份 home
  // 解析。必须在任何 `registerXxxLlm` 之前调用 —— 各适配器经
  // `registerAdapterIdempotent` 注册时就会包装上剔除逻辑（见该函数注释）。
  configureDeadModelStore(ctx)

  // ===== Token 账本持久化（第 2 期 · 日聚合落盘）=====
  //
  // ⚠️ 账本本体是模块级单例（`token-ledger.ts`），没有 ctx 可拿 —— 故在启动时
  // 把后端挂进去（`attachTokenLedgerStore`）。挂载发生在**任何适配器注册之前**：
  // 启动早期就有模型请求（标题生成等）时，落盘已在位。
  //
  // ⚠️ 后端契约是**绝不抛错**（`recordTokenUsage` 的调用点在推理关键路径上，
  // 见其函数注释），`FileLedgerStore` 内部已按此实现。
  //
  // ⚠️ dispose **必须用返回的 disposer**（不能无条件 `attach(undefined)`）：
  // 插件 fiber 重启时新 apply 与旧 fiber 的异步 dispose **交错执行**
  //（本仓库已确证的事故，见 `llm-register-compat.ts` 模块头），无条件摘会把
  // **新实例刚挂上**的后端摘空 ⇒ 落盘停摆且历史视图恒为空。disposer 自带所有权
  // 校验（只摘自己的），并顺带 `flush` 当前这份数据。
  const tokenLedgerStore = createTokenLedgerStore(ctx)
  const detachTokenLedger = attachTokenLedgerStore(tokenLedgerStore)
  ctx.effect(() => () => {
    try {
      tokenLedgerStore.flush()
    } finally {
      detachTokenLedger()
    }
  }, 'token-ledger-persistence')

  // WorkBuddy provider 已从中国版（copilot.tencent.com）改造为国际版
  // （www.workbuddy.ai）。旧账号存的是中国版凭据，其 token.domain 指向旧端点，
  // 用新 endpoint 发请求必然失败且会一直续期失败，故启动时清理掉。
  // 判据是「凭据 domain ≠ 产品 apiDomain」，只清真正失配的条目。
  void pool.pruneAccountsWithForeignDomain(WORKBUDDY).then((removed) => {
    if (removed.length > 0) {
      ctx.logger.info(
        `[channel-pack] 已清理 ${removed.length} 个 WorkBuddy 旧版（中国版）账号，请重新登录：${removed.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[channel-pack] 清理 WorkBuddy 旧版账号失败：${String(error)}`)
  })

  // ===== WorkBuddy (腾讯 WorkBuddy) 服务 =====
  // 与 CodeBuddy 同源（同后端、同协议），差异全部由 product 配置承载。
  // 服务名由 BuddyAuth 依 product.id 派生，故两个产品分别注册为
  // ctx.buddyAuth / ctx.workbuddyAuth，互不覆盖。
  // 同样不注册斜杠命令：入口在 Channel Pack 的 WorkBuddy 面板。
  const workbuddy = new BuddyAuth(ctx, { product: WORKBUDDY })
  const workbuddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(WORKBUDDY.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      // 只从 workbuddy 的账号池取账号，回退到 WorkBuddy 自己的单凭据 ref，
      // 保证不会串用 CodeBuddy 的凭据。
      // 选号策略与 CodeBuddy 同款，但用的是**WorkBuddy 自己的锁状态与余额缓存**
      // （两站积分构成不同：实测国际版是「Bonus Pack 14 天 + Free Plan 长期」）。
      const picked = await pickBuddyCredential({
        product: WORKBUDDY,
        selector: workbuddyBalanceSelector,
        displayName: 'WorkBuddy',
        modelId,
        // 免费模型跳过「锁定 + 临期积分」这道门（判据见 BuddyAdapter.isFreeModel）。
        // 用户报障「账户可用却提示没有可用账号」正是缺了这一条：免费模型不扣积分，
        // 却被永久积分锁定拦下。
        isFreeModel: await workbuddyAdapter.isFreeModel(modelId),
      })
      if (picked.credential) return picked.credential
      // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
      // provider 实参用 WORKBUDDY.id 而非字面量 'workbuddy'（同类坑见上）。
      const available = await pool.getAvailableAccount(WORKBUDDY.id, modelId ?? '', picked.tried)
      // Token 账本（第 2 期）：回报「本笔请求解析出的账号」。
      if (available) {
        reportLedgerAccount(WORKBUDDY.id, available.entry.id)
        return available.credential as BuddyCredential
      }
      // 同 buddy：区分「全部限流」与「真的没登录」（见该助手的说明）。
      throwIfAllAccountsRateLimited(WORKBUDDY, modelId)
      const resolved = await ctx.credentials.resolve(credentialRef(WORKBUDDY.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as BuddyCredential
      } catch {
        return undefined
      }
    },
    // 同上：必须刷池内账号（`WORKBUDDY_ACCESS_TOKEN` 从未被写入过）。
    // 这条正是「workbuddy + deepseek-v4.1-flash 一直报未配置凭据」的根因。
    refresh: createPoolRefresh(pool, 'workbuddy', workbuddy),
    fetchRemoteModels: () => workbuddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: WORKBUDDY,
  })

  // ===== Channel Pack RPC 注册（单渠道版本）=====
  // 只保留 workbuddy（国际版）：其余 provider 不创建 Auth 实例、不注册 llm 适配器。
  // 渠道列表由 llm 的已注册适配器派生，因此控制台只会出现 WorkBuddy 国际版。
  const pruned = <T extends object>(provider: string, adapter: T): T => {
    try {
      return withDeadModelPruning([provider], adapter);
    } catch (error) {
      ctx.logger.warn(`[channel-pack] ${provider} 的失效模型剔除包装失败，使用原适配器: ${String(error)}`);
      return adapter;
    }
  };
  const modelAdapters: Record<string, { listAllModels(): readonly { id: string; name: string }[] }> = {
    workbuddy: pruned("workbuddy", workbuddyAdapter),
  };

  registerChannelPackRpc(
    ctx, pool,
    undefined as never, // codearts
    undefined as never, // buddy（国内版 CodeBuddy）
    workbuddy,
    undefined as never, // lobsterai
    undefined as never, // qoder
    undefined as never, // qodercn
    undefined as never, // trae
    undefined as never, // cline
    undefined as never, // loomy
    undefined as never, // raccoon
    undefined as never, // minimax
    undefined as never, // zcode
    undefined as never, // gemini
    undefined as never, // qwenwork
    modelAdapters,
    {
      ...config,
      codeartsFetcher: signedNetwork.fetch,
    },
  )
  // 网关是旁路功能：这里传 `pool` 只为读设置页里的开关，其内部任何失败都已
  // 自行降级为日志，绝不会让插件 apply() 失败。
  mountOpenAiGateway(ctx, pool)
  // 思考死循环被中止后的**自动续跑**：把此前必须由用户手打「继续」的那一步
  // 自动化（真实报障 2026-10-04，见 `loop-recovery.ts` 模块头）。
  installLoopResume(ctx)
  ctx.provide("accountPool", pool)
}
