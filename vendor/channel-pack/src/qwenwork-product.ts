/**
 * 千问办公（QwenWorkCN）产品配置。
 *
 * 单一真相源模式（与 minimax-product.ts 同型）：产品差异收敛到这里，
 * 渠道其余文件只读本文件字段。数据来源全部实测（2026-10-18）：
 * 网关/端点/模型档位见 `qwenwork.ts` 模块头，此处只放渠道编排需要的字段。
 */

/** 兜底模型表条目（静态表；远端目录端点需 WASM 签名，v1 不拉）。 */
export interface QwenworkModelEntry {
  /** 模型 key（推理端点认的就是它）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 上下文窗口（模型配置 `max_input_tokens` 同口径，1M）。 */
  contextWindow: number
  /** 单次输出上限（parameters.max_tokens 兜底）。 */
  maxTokens: number
  /** 是否支持图片输入（qwork 全档 is_vl=true）。 */
  supportsImage: boolean
}

/** 千问办公产品常量。 */
export interface QwenworkProduct {
  /** 渠道 id（模型 id 前缀 + 账号池 provider 键）。 */
  id: string
  /** 展示名。 */
  displayName: string
  /** 网关 origin。 */
  gateway: string
  /** 单凭据回退 ref（无账号池时）。 */
  defaultCredentialRef: string
  /** 兜底模型表。 */
  fallbackModels: readonly QwenworkModelEntry[]
}

export const QWENWORK: QwenworkProduct = {
  id: 'qwenwork',
  displayName: '千问办公 QwenWork',
  gateway: 'https://gateway.qwenwork.cn',
  defaultCredentialRef: 'QWENWORK_ACCESS_TOKEN',
  fallbackModels: [],
}
