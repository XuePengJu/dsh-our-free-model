# WorkBuddy Gateway · 单渠道本地网关

只保留 **WorkBuddy 国际版**（`www.workbuddy.ai`）一个账号渠道的本地 AI 网关，
带独立管理控制台。从 [`dsh-our-free-model`](../../) fork 剪裁而来。

---

## 这个分支做了什么

原项目是一个 dsh 插件 + 独立服务，内置四条模型车道（匿名免费 / Kilo 免费池 / EAC 协付 / 聚合）
和十四个账号渠道。本分支只保留一条路：WorkBuddy 国际版账号渠道。

| 保留 | 删除 |
| --- | --- |
| WorkBuddy 国际版账号渠道（登录、账号池、积分选号、模型清单、推理） | dsh 插件形态（`index.js` / `client.js` / `cordis.patch.yml` / `adapter/` / `catalog/` / `feed/` / `locale/`） |
| 独立控制台：概览、模型清单、用量与路由、请求日志、账号池、服务设置 | 免费车道（OpenCode Zen 匿名 + Kilo 免费池） |
| OpenAI / Anthropic 兼容本地网关（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`） | 其余 13 个账号渠道（CodeBuddy 国内版、Qoder、TRAE、Cline、Loomy、Raccoon、MiniMax、ZCode、Gemini、CodeArts、LobsterAI、千问办公…） |
| 模型别名、单模型启停、可用性探活 | 模型组（combo）与 WorkBuddy 配置同步 |
| 桌面壳（Tauri，Windows / macOS） | EAC 协付渠道入口、聚合渠道（75 家自带 Key 提供商） |

## 启动

```bash
npm run start:standalone
```

- 默认端口 **18910**（被占用时自动顺延；`--port` 可覆盖）
- 默认数据目录 **`~/.workbuddy-gateway`**（`OFM_HOME` 可覆盖）
  —— 与原项目的 `~/.our-free-model` 完全隔离，两个版本可以并存
- 启动后打开终端打印的一次性管理链接（10 分钟内有效），或直接打开 `http://127.0.0.1:18910/`
  —— 本机访问会自动用本机令牌登录

首次使用需要先在控制台「账号池」里登录一个 WorkBuddy 国际版账号（浏览器登录），
之后模型清单会跟随该账号的下发目录刷新。

## 对外接口

```text
GET  /v1/models
POST /v1/chat/completions   流式 / 非流式
POST /v1/responses          流式 / 非流式
POST /v1/messages           Anthropic Messages
POST /v1/messages/count_tokens
```

API 地址 `http://127.0.0.1:18910/v1`，Key 在控制台「概览 · 快速接入」里复制，
或从 `~/.workbuddy-gateway/settings.json` 的 `forwardKey` 字段取。

## 构建

```bash
# 依赖（根目录装 jose/undici，packages/standalone 装 esbuild/vite/react）
npm install && npm --prefix packages/standalone install

# 渠道包（vendored 渠道源 → 单文件产物）
OFM_ESBUILD_DIR=packages/standalone npm run channel-pack
npm run build:standalone-channels     # → packages/standalone/channels/business.mjs

# 控制台前端（React + TypeScript，产物提交在 packages/standalone/web/）
npm run build:standalone-ui

# 桌面壳
npm run pack:standalone
```

需要 Node `^22.19.0 || >=24.0.0`。

## 目录

```text
src/                      网关核心（转发、流式、统计、别名、渠道路由）
src/core/runtime.js       单渠道运行时（核心目录恒为空，模型行全部来自渠道 Worker）
packages/standalone/      独立服务：service / management / channels / frontend / web
packages/standalone/channels/business.mjs   渠道业务产物（由 vendor 源构建，勿手改）
packages/standalone/frontend/shared-channels.js  账号池 / 请求日志页组件源
vendor/channel-pack/      渠道包源（TypeScript）+ 构建产物 pack.js
scripts/                  构建与测试脚本
```

## 来源与许可

MIT。原项目 [`Ebony-Vinyl/dsh-our-free-model`](../../) 的版权声明完整保留在 `LICENSE`
与 `vendor/channel-pack/LICENSE`、`vendor/channel-pack/NOTICE.md` 中。本分支的剪裁
同样以 MIT 发布。

被剪掉的上游渠道实现仍可从原仓库获取；本分支不再跟随上游更新渠道包。
