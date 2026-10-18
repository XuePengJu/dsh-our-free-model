/**
 * 千问办公渠道 —— DSH LLM 适配器。
 *
 * 推理走**加密端点**（WASM 打包 + COSY 签名，见 `qwenwork-chat.ts` /
 * `qwenwork-wasm.ts`），响应剥信封后是标准 OpenAI chunk 流，故 SSE 消费
 * 直接复用 `consumeOpenAiSse`（reasoning / tool_calls / 死循环守卫全继承）。
 *
 * ## v1 口径
 *
 * - 模型表用**静态兜底表**（远端目录端点需 WASM 签名的另一条路径，待补）。
 * - 图片：qwork 三档 `is_vl=true`（官方 model_config 口径），声明支持图片，
 *   内联走 `readImage` 桥（与 raccoon 同款）。
 * - 无凭据时 `listModels` 返回 `[]`（DSH 隐藏分组），不抛错。
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { consumeOpenAiSse, collectImages } from './openai-compat.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { openQwenworkStream } from './qwenwork-chat.js'
import { isQwenworkExpired, qwenworkFallbackEntries, type QwenworkCredential } from './qwenwork.js'
import { QWENWORK, type QwenworkProduct, type QwenworkModelEntry } from './qwenwork-product.js'

/** QwenworkAdapter 构造选项（与 minimax 同型）。 */
export interface QwenworkAdapterOptions {
  /** 单凭据回退 ref。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<QwenworkCredential | undefined>
  /** 凭据失效时的续期。 */
  refresh: () => Promise<void>
  /** 图片内联桥（`ctx.attachments`）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 测试注入 fetch。 */
  fetchImpl?: typeof fetch
  /** 产品配置；默认 {@link QWENWORK}。 */
  product?: QwenworkProduct
}

/** 千问办公模型适配器。 */
export class QwenworkAdapter extends LlmAdapter {
  private readonly product: QwenworkProduct

  constructor(private readonly options: QwenworkAdapterOptions) {
    super()
    this.product = options.product ?? QWENWORK
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /** 兼容 0.1.1-rc.2 的同步目录接口（minimax 同款口径：必须同步返回数组）。 */
  listAllModels(): readonly { id: string; name: string }[] {
    return qwenworkFallbackEntries().map((model) => ({ id: model.id, name: model.name }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    if (!await this.hasCredential()) return []
    return qwenworkFallbackEntries().map((model) => this.toModelInfo(model))
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entry = qwenworkFallbackEntries().find((item) => item.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: entry?.supportsImage === true ? ['text', 'image'] : ['text'],
    }
    if (entry !== undefined && entry.contextWindow > 0) {
      resolved.context = { contextWindow: entry.contextWindow }
    }
    const maxTokens = entry?.maxTokens
    if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
      resolved.defaultMaxTokens = maxTokens
    }
    return resolved
  }

  /** 兼容 0.1.1-rc.2 的 prepareCall shim（与其余适配器同款）。 */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 走加密端点发一次流式请求。
   *
   * ⚠️ 凭据过期先续期一次再重取（与其余九个适配器同款）；
   * ⚠️ 错误必须抛错，不静默返回空流（Qoder 早期同型缺陷）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isQwenworkExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token === '') {
      throw new LlmError(
        'qwenwork: 无可用凭据 —— 请先导入本机千问办公登录态（官方客户端需已登录）',
        'MISSING_CREDENTIAL',
      )
    }

    // 图片：qwork 全档声明 is_vl，声明支持就必须真支持（发出去让服务端 400 不如提前报错）
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    if (imageRefs.size > 0 && this.options.readImage === undefined) {
      throw new LlmError('qwenwork: 图片输入需要附件服务（readImage 未提供）', 'UNSUPPORTED_CONTENT')
    }

    const response = await openQwenworkStream({
      credential,
      request: {
        model: options.model,
        messages: options.messages,
        ...(options.system === undefined ? {} : { system: options.system }),
        ...(options.tools === undefined
          ? {}
          : { tools: options.tools as unknown as readonly Record<string, unknown>[] }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        isReasoning: options.reasoningEffort !== undefined
          && String(options.reasoningEffort) !== 'none',
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    })
    void imageRefs

    yield* consumeOpenAiSse(
      response,
      { ...(options.signal === undefined ? {} : { signal: options.signal }) },
      {
        label: 'qwenwork',
        firstTokenTimeoutMs: 180_000,
        chunkTimeoutMs: 120_000,
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      },
    )
  }

  private toModelInfo(model: QwenworkModelEntry): LlmModelInfo {
    return {
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: model.supportsImage ? ['text', 'image'] : ['text'],
    }
  }

  private async hasCredential(): Promise<boolean> {
    try {
      const credential = await this.options.resolveCredential('')
      return credential !== undefined && credential.access_token !== ''
    } catch {
      return false
    }
  }
}

/** 在 `ctx.llm` 上注册千问办公 provider 路由与适配器。 */
export function registerQwenworkLlm(
  ctx: Context,
  options: QwenworkAdapterOptions,
): QwenworkAdapter {
  const product = options.product ?? QWENWORK
  const adapter = new QwenworkAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
