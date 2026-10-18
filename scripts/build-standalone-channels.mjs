/** 从已发布渠道包生成独立业务产物；平台接口替换必须明确匹配。 */
import fs from 'node:fs'
import crypto from 'node:crypto'

const source = fs.readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')
let output = source
function replaceOnce(from, to) {
  if (output.split(from).length !== 2) throw new Error(`独立渠道生成位置不唯一或已改变：${from.slice(0, 90)}`)
  output = output.replace(from, to)
}
// 独立应用不注册宿主设置表单，删除两个仅供宿主使用的 schema。
output = output.replace(/^import Schema2? from "@deepseek-ai\/schemastery";\r?\n/gm, '')
replaceOnce(output.match(/var channelPackSchema = Schema\.object\(\{[\s\S]*?\n\}\);/)?.[0] ?? 'missing schema', 'var channelPackSchema;')
replaceOnce(output.match(/var Config = Schema2\.object\(\{[\s\S]*?\n\}\);/)?.[0] ?? 'missing config', 'var Config;')
output = output.replace(/from "@deepseek-ai\/(?:cordis|dsh-credentials|dsh-llm)"/g, 'from "./contracts.mjs"')
replaceOnce(output.match(/function resolveChannelPackHome\(ctx\) \{[\s\S]*?\n\}/)?.[0] ?? 'missing home resolver',
  'function resolveChannelPackHome(ctx) {\n  if (typeof ctx.platform?.channelHome !== "string") throw new Error("独立渠道缺少数据目录");\n  return ctx.platform.channelHome;\n}')
replaceOnce('  mountOpenAiGateway(ctx, pool);\n  installLoopResume(ctx);', '  // 独立服务由外层提供统一网关，宿主 Agent 自动续跑没有对应服务。')
// 「把限流误报成未登录」是这批渠道里最误导的一类报错：账号池把「候选全在
// 限流窗口内」与「根本没有凭据」都归成 `null` 返回，适配器于是抛出
// `no usable credential; log in first`，把用户赶去重新登录（而登录并不能
// 解除限流）。这里在**唯一的收口点** AccountPool.getAvailableAccount 上把两者
// 分开：只有当该 provider 的启用账号确实全部处于该模型的限流窗口内时，才抛出
// 带解禁时间的配额错误（措辞与宿主版 throwIfAllAccountsRateLimited 对齐），
// 使各家渠道（qoder / qodercn / trae / raccoon / minimax / gemini / zcode…）
// 一次性获得准确文案；真的没有凭据时仍返回 null，走各适配器原有的「请先登录」。
replaceOnce(
  '    if (candidates.length === 0) return null;',
  [
    '    if (candidates.length === 0) {',
    '      if (modelId.length > 0) {',
    '        const limited = allAccountsRateLimitedForModel(',
    '          this.readAccounts().filter((a) => a.provider === provider && a.enabled),',
    '          modelId',
    '        );',
    '        if (limited !== void 0) {',
    '          throw new LlmError20(',
    '            `${provider}：模型 ${modelId} 的可用账号均在限流中，最近一个将于 ${new Date(limited.resetAtMs).toLocaleString("zh-CN")} 解禁。可改用其它 provider / 模型，或等待解禁后再试（无需重新登录）。`,',
    '            "QUOTA_EXCEEDED"',
    '          );',
    '        }',
    '      }',
    '      return null;',
    '    }',
  ].join('\n'),
)
replaceOnce('resolve(dirname(fileURLToPath(import.meta.url)), "qoder-auth-wasm.wasm")', 'fileURLToPath(new URL("../../../vendor/channel-pack/qoder-auth-wasm.wasm", import.meta.url))')
// ⚠️ esbuild 会给第二个同名 import 加数字后缀（resolve2/dirname2/fileURLToPath2），
// 重命名随版本漂移 —— 用正则一次替换而不是精确串匹配。
{
  const wasmReplace = output.match(
    /resolve\d*\(dirname\d*\(fileURLToPath\d*\(import\.meta\.url\)\), "qwenwork-auth-wasm\.wasm"\)/,
  )
  if (wasmReplace === null || output.split(wasmReplace[0]).length !== 2) {
    throw new Error('qwenwork wasm 路径表达式未找到或不唯一（esbuild 产物形状变了？）')
  }
  output = output.replace(
    wasmReplace[0],
    'fileURLToPath(new URL("../../../vendor/channel-pack/qwenwork-auth-wasm.wasm", import.meta.url))',
  )
}
replaceOnce('  const override = process.env.DSH_CODEARTS_CACHE_DIR;', '  const override = process.env.OFM_CODEARTS_CACHE_DIR;')
replaceOnce('export {\n  Config,', `export {
  toGenerateOptions, toResponsesGenerateOptions, normalizeReasoningEffort,
  responsesReasoningEffort, normalizeMaxTokens, responsesMaxOutputTokens,
  markGatewayChannel,
  collectGatewayModels, collectGatewayEffortViews, toOpenAiModels,
  Config,`)
if (/@deepseek-ai\/.*["'];/.test(output)) throw new Error('独立产物仍存在宿主 import')
output = `// 由 scripts/build-standalone-channels.mjs 生成，请勿手改。\n// 原渠道包 SHA256: ${crypto.createHash('sha256').update(source).digest('hex')}\n${output}`
const file = new URL('../packages/standalone/channels/business.mjs', import.meta.url)
if (process.argv.includes('--check')) {
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== output) throw new Error('独立渠道产物需要重新生成')
} else {
  fs.mkdirSync(new URL('../packages/standalone/channels/', import.meta.url), { recursive: true })
  fs.writeFileSync(file, output)
}
console.log('独立渠道产物校验通过')
