# EAC 历史观察记录（2026-11-18，作者自报）

本页整理自 PR #882 作者提交的实测记录。请求时间为 **2026-11-18 23:40–23:55（北京时间，UTC+8）**，作者记录时间为 2026-11-19。维护者未在本文中重新执行这些请求，也未取得可逐项核验的原始响应日志。

**每个模型仅请求一次（n=1）。这些结果是该作者在当晚特定账号、出口与网关上的观察，不是当前可用率、性能保证或服务整体质量的统计结论。** 模型、网关路由和上游状态均可能在此后变化；请以自己的当前请求结果为准。

## 作者报告的测试方法

作者使用已登录并 star 的 GitHub 账号完成 EAC 授权，本机直连网关，报告的 API base URL 为 `https://ourfreemodel.beichenapi.com/eac/v1`。测试使用 Chat Completions、`stream: true`，`max_tokens` 为 160–260；以第一个正文帧记录首字时间。该 base URL 已包含 `/v1`，调用时不应再重复拼接一层 `/v1`。

## 作者报告的结果

| 模型 ID（当时使用） | 当次观察 | 作者报告的说明 |
| --- | --- | --- |
| `deepseek-ai/deepseek-v4.1-flash` | 不可用 | 网关返回 `end of life on 2026-11-16T08:00:00Z` |
| `opencode/deepseek-v4.1-flash-free` | 不可用 | `model_concurrency`，原文为 `Paid accounts are admitted first` |
| `amd/DeepSeek-V4.1-Flash` | 无正文输出 | HTTP 200，0 字 |
| `openai/gpt-oss-20b` | 无正文输出 | HTTP 200，0 字 |
| `stepfun-ai/step-5-preview` | 超时 | 300 秒，0 字 |
| `z-ai/glm-5.3-flash` | 返回正文 | 首字 213,053 ms，160 tok，75.1 tok/s |
| `minimaxai/minimax-m3.1-flash` | 返回正文 | 首字 173,221 ms，160 tok，12.4 tok/s |

表中的首字时间、Token 数与速度保留作者原始数值。原记录未提供全部提示词、客户端版本、完整请求体、响应帧和速度计算明细，因此不能据此独立复算吞吐或做不同模型之间的可靠性能比较。HTTP 200 本身也不能证明已经返回有效正文。

## 资源池显示值的代码来源

原记录指出 `worker/gateway-node.mjs` 的 `poolSnapshot` 使用以下逻辑。核对本地 2026-11-27 审查基线时，该实现仍存在：

```js
if (poolSizeOverride > 0) { pool = poolSizeOverride; poolSource = 'configured' }
else {
  const stars = await loadStars()
  if (Number.isFinite(stars)) { pool = Math.round(stars * 1.5); poolSource = 'formula' }
}
```

因此，这份 Node 网关实现的 `/pool` 显示值可能来自 `POOL_SIZE` 配置，也可能来自仓库 star 数乘 1.5 后四舍五入；二者都不是代码对实际账号数的实时盘点。该代码观察不证明线上网关当时部署了同一版本，也不单独证明其真实账号数量。

## 重新观察时应记录什么

在自己完成 EAC 授权后，使用当前模型清单中的 ID 发起最小请求，并保留时间和时区、客户端版本、模型 ID、脱敏请求参数、HTTP 状态、业务错误、首个正文帧时间及正常结束情况。请求会发送内容到上游，也可能消耗配额；一次失败或成功均只能说明该次请求。

请勿公开访问令牌、Cookie、签名密钥或含敏感内容的提示词。桌面插件与独立服务的界面入口可能变化，授权和接口用法以当前界面及 [独立服务说明](../packages/standalone/README.md) 为准。
