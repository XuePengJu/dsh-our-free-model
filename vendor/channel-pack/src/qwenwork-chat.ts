/**
 * 千问办公渠道 —— 加密推理传输层。
 *
 * 职责链：**构造明文体**（官方 1.0.4 `build_body` 形状）→ **WASM 打包**
 * （`prepareQwenworkInfer`，产出带 `Encode=1` 的 URL / COSY 头 / 密文体）→
 * **POST SSE** → **剥外层信封**（`{statusCodeValue, body}`）→ 还原成
 * OpenAI chunk 流交给 `consumeOpenAiSse`（复用 reasoning / tool_calls /
 * 死循环守卫等既有能力，不重造轮子）。
 *
 * 实测基线（2026-10-18）：`qwork-advanced` HTTP 200，SSE 3 帧即完整回复，
 * usage 完整；信封剥壳规则见 `unwrapQwenworkSsePayload`。
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { httpErrorCode, serializeMessages } from './openai-compat.js'
import { prepareQwenworkInfer } from './qwenwork-wasm.js'
import {
  QWENWORK_BUSINESS_PRODUCT,
  QWENWORK_BUSINESS_TYPE,
  QWENWORK_CHAT_PATH,
  QWENWORK_CHAT_QUERY,
  QWENWORK_BUILD,
  QWENWORK_CLIENT_TYPE,
  QWENWORK_COSY_VERSION,
  QWENWORK_DATA_POLICY,
  QWENWORK_GATEWAY,
  QWENWORK_IDE_VERSION,
  QWENWORK_LOGIN_VERSION,
  QWENWORK_MACHINE_OS,
  QWENWORK_MACHINE_TYPE,
  QWENWORK_RELEASE_VERSION,
  QWENWORK_SCENE,
  QWENWORK_USER_AGENT,
  normalizeQwenworkModel,
  qwenworkEnvelopeError,
  unwrapQwenworkSsePayload,
  type QwenworkCredential,
} from './qwenwork.js'

/** 构造加密推理请求的入参（与 DSH GenerateOptions 对齐的子集）。 */
export interface QwenworkChatRequest {
  model: string
  messages: readonly { role: string; content: unknown }[]
  system?: string
  tools?: readonly Record<string, unknown>[]
  temperature?: number
  maxTokens?: number
  /** 是否请求思考输出（`is_reasoning`）。 */
  isReasoning?: boolean
}

/** chat 请求的静态身份头（1.0.4 桌面端；COSY 鉴权头由 WASM 追加）。 */
function qwenworkStaticHeaders(modelKey: string, requestId: string, machineId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'text/event-stream',
    'Content-Type': 'application/json',
    'User-Agent': QWENWORK_USER_AGENT,
    'X-Request-Id': requestId,
    'X-QwenWork-Version': QWENWORK_IDE_VERSION,
    'X-QwenWork-Release-Version': QWENWORK_RELEASE_VERSION,
    'X-QwenWork-Build': QWENWORK_BUILD,
    'X-QwenWork-Platform': 'win32',
    'X-QwenWork-Arch': 'x64',
    'X-QwenWork-Channel': 'stable',
    'Cosy-Version': QWENWORK_COSY_VERSION,
    'Cosy-ClientType': QWENWORK_CLIENT_TYPE,
    'Cosy-Business-Product': QWENWORK_BUSINESS_PRODUCT,
    'Cosy-Business-Type': QWENWORK_BUSINESS_TYPE,
    'Cosy-Scene': QWENWORK_SCENE,
    'Cosy-MachineOS': QWENWORK_MACHINE_OS,
    'Cosy-MachineType': QWENWORK_MACHINE_TYPE,
    'Cosy-Data-Policy': QWENWORK_DATA_POLICY,
    'Login-Version': QWENWORK_LOGIN_VERSION,
    'X-Model-Key': modelKey,
    'X-Model-Source': 'system',
    'Cache-Control': 'no-cache',
    'Accept-Encoding': 'identity',
  }
  if (machineId !== '') {
    headers['Cosy-MachineId'] = machineId
    headers['Cosy-MachineToken'] = machineId
  }
  return headers
}

/**
 * 构造明文请求体（官方 1.0.4 `build_body` 形状，逐字段对齐）。
 *
 * ⚠️ `business` 决定服务端路由（Qoder 实测：缺失会被路由到故障节点）；
 * `chat_context` 不能传空对象 —— 两者都是同源渠道踩过的真实坑。
 */
export function buildQwenworkBody(
  request: QwenworkChatRequest,
  ids: { requestId?: string } = {},
): { body: Record<string, unknown>; modelKey: string } {
  const modelKey = normalizeQwenworkModel(request.model)
  const requestId = ids.requestId ?? crypto.randomUUID()
  // OpenAI wire 消息（system/assistant(tool_calls+reasoning)/user/tool 全兼容）
  const wire = serializeMessages(request.messages)
  const systemParts: string[] = []
  const rest: Record<string, unknown>[] = []
  for (const message of wire) {
    if (message.role === 'system') {
      const text = message.content
      if (typeof text === 'string' && text.length > 0) systemParts.push(text)
      continue
    }
    rest.push(message)
  }
  if (typeof request.system === 'string' && request.system.trim().length > 0) {
    systemParts.unshift(request.system)
  }
  const system = systemParts.join('\n\n')
  const messages = system.length > 0
    ? [{ role: 'system', content: system }, ...rest]
    : rest

  // `chat_context.text` 取最后一条 user 消息（官方口径）
  let lastUserText = ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i]
    if (candidate.role === 'user' && typeof candidate.content === 'string') {
      lastUserText = candidate.content
      break
    }
  }

  const parameters: Record<string, unknown> = {}
  if (request.temperature !== undefined) parameters.temperature = request.temperature
  parameters.max_tokens = request.maxTokens ?? 32_000

  const isReasoning = request.isReasoning ?? false
  const body: Record<string, unknown> = {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: crypto.randomUUID(),
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text: lastUserText,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoning },
        originalContent: lastUserText,
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: 'qoder_work',
    aliyun_user_type: '',
    model_config: {
      key: modelKey,
      display_name: modelKey,
      model: '',
      format: 'openai',
      is_vl: true,
      is_reasoning: isReasoning,
      api_key: '',
      url: '',
      source: 'system',
      max_input_tokens: 1_000_000,
    },
    system,
    messages,
    tools: request.tools ?? [],
    parameters,
    business: {
      product: QWENWORK_BUSINESS_PRODUCT,
      type: QWENWORK_BUSINESS_TYPE,
      version: '1',
      feature_switches: {},
    },
  }
  return { body, modelKey }
}

/**
 * 打包并发起流式推理，返回**剥好信封**的 OpenAI SSE `Response`
 * （供 `consumeOpenAiSse` 直接消费）。
 */
export async function openQwenworkStream(options: {
  credential: QwenworkCredential
  request: QwenworkChatRequest
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch
  const { body, modelKey } = buildQwenworkBody(options.request)
  const prepared = await prepareQwenworkInfer({
    uid: options.credential.uid,
    name: options.credential.name,
    email: options.credential.email,
    accessToken: options.credential.access_token,
    machineId: options.credential.machine_id,
    body: JSON.stringify(body),
    modelKey,
    endpoint: QWENWORK_GATEWAY,
  })

  const headers = qwenworkStaticHeaders(
    modelKey,
    crypto.randomUUID(),
    options.credential.machine_id ?? '',
  )
  // ⚠️ WASM 生成的 COSY 鉴权头必须原样透传（覆盖会 403）
  for (const [key, value] of Object.entries(prepared.headers)) headers[key] = value

  const url = prepared.url.startsWith('http')
    ? prepared.url
    : `${QWENWORK_GATEWAY}${prepared.url}`
  const upstream = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: prepared.body,
    signal: options.signal,
  })

  if (!upstream.ok || upstream.body === null) {
    const text = upstream.body === null ? '' : await upstream.text().catch(() => '')
    throw new LlmError(
      `qwenwork: HTTP ${upstream.status}${text === '' ? '' : ` — ${text.slice(0, 500)}`}`,
      httpErrorCode(upstream.status),
      { status: upstream.status },
    )
  }

  // 剥信封：逐行读上游 SSE，`data:` 帧经 unwrap 还原为内层 OpenAI 帧。
  const decoder = new TextDecoder('utf-8')
  const encoder = new TextEncoder()
  let buffer = ''
  const unwrapped = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let newlineAt = buffer.indexOf('\n')
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt).replace(/\r$/, '')
        buffer = buffer.slice(newlineAt + 1)
        emitLine(line, controller, encoder)
        newlineAt = buffer.indexOf('\n')
      }
    },
    flush(controller) {
      if (buffer.length > 0) emitLine(buffer, controller, encoder)
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    },
  }))
  return new Response(unwrapped, { status: upstream.status })
}

function emitLine(
  line: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: { encode(text: string): Uint8Array },
): void {
  if (!line.startsWith('data:')) return
  const data = line.slice(5).trim()
  if (data === '') return
  const envelopeError = qwenworkEnvelopeError(data)
  if (envelopeError !== null) {
    // 信封错误带原文抛给消费层（consumeOpenAiSse 会把它当 SSE error 帧）
    controller.enqueue(encoder.encode(
      `data: ${JSON.stringify({ error: { message: envelopeError } })}\n\n`,
    ))
    return
  }
  for (const inner of unwrapQwenworkSsePayload(data)) {
    controller.enqueue(encoder.encode(`data: ${inner}\n\n`))
  }
}
