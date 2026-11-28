# 独立本地服务中文快速上手

本指南面向完整仓库中的 `packages/standalone`，不需要安装 DSH。服务提供本机网页控制台和模型 API。完整参数与功能说明见 [独立服务说明](../packages/standalone/README.md)。本指南按 2026-11-27 的本地审查代码编写；安装制品和远程管理部署的支持范围请以当前仓库说明为准。

## 环境与启动

在项目的完整仓库根目录执行命令，不要仅复制 `packages/standalone`：它还依赖 `src/`、`vendor/`、`catalog/` 等目录。

- Node.js 必须满足根 `package.json` 的 `engines.node`：`^22.19.0 || >=24.0.0`。只看到主版本为 22 并不能证明已满足最低小版本要求。
- Windows、macOS 和 Linux 使用同一独立服务入口；部分账号登录或桌面功能仍有各自的平台要求。
- OpenCode 匿名免费推理的默认传输还需要本机 Bun。其他渠道有自己的网络和账号要求；模型出现在清单中不等于已完成推理验证。

```powershell
node -v
npm ci
npm run start:standalone
```

也可以直接启动入口，并显式选择数据目录：

```powershell
node packages/standalone/cli.mjs --port 18900 --data-dir "F:/ofm-data"
```

本机默认端口为 18900；保存的端口或 `--port` 可改变它，端口冲突时可能自动选择其他可用端口。以终端打印的实际 API 地址为准；`--port 0` 让系统分配端口。终端还会打印一次性管理链接和密钥文件位置，不会打印密钥内容。

## 数据目录与配置

数据目录按以下顺序选择：`--data-dir` > 非空 `OFM_HOME` > 用户目录下的 `.our-free-model`。独立入口不读取 `DSH_HOME`，也不会自动导入插件的配置或账号。不要将独立服务指向插件的 `~/.dsh/our-free-model` 数据目录。

端口、LAN 和其他产品设置保存在当前数据目录的 `settings.json` 中。网页控制台修改的也是这些持久设置，并不是另一个低优先级配置层。CLI 的 LAN 开关会保存选择；`--no-refresh` 只控制本次启动的核心刷新任务。

### 可选：用 `.env` 传入环境变量

Node 不会为普通启动命令自动加载 `.env`。可以自行创建 `packages/standalone/.env`，仅填写需要的项，例如：

```dotenv
# 使用绝对路径；不要指向 DSH 插件的数据目录。
OFM_HOME=F:/ofm-data

# 可选代理；不用的项保留注释。
# HTTPS_PROXY=http://127.0.0.1:7890
# HTTP_PROXY=http://127.0.0.1:7890
# ALL_PROXY=socks5://127.0.0.1:7890
# NO_PROXY=localhost,127.0.0.1,::1

# 仅在需要指定 Bun 路径时设置。
# OUR_FREE_MODEL_BUN=C:/tools/bun/bun.exe
```

然后仍在仓库根目录执行：

```powershell
node --env-file=packages/standalone/.env packages/standalone/cli.mjs
```

这里直接使用 Node 的 `--env-file`，不依赖额外的 `start:env` 脚本。已经由启动进程设置的环境变量优先于该文件中的同名值。文件可能包含代理凭据或本地路径，请自行妥善保管，提交前检查 `git status`；不要假定仓库已替你忽略该文件。

### 代理适用范围

账号渠道的共享出网层按目标协议读取 `HTTPS_PROXY` 或 `HTTP_PROXY`，再回退 `ALL_PROXY`；遵守 `NO_PROXY`。没有配置环境代理时，Windows 可读取当前用户的手动系统代理，并遵守 `ProxyOverride`；不支持 PAC，回环请求不自动加代理。Gemini / Cline 的浏览器授权成功，不代表服务后台已能访问令牌与模型端点。

匿名 OpenCode 车道有独立传输规则：其环境代理读取 `HTTPS_PROXY`，再回退 `HTTP_PROXY`，并遵守 `NO_PROXY`；不要假定 `ALL_PROXY` 或系统代理对所有车道都有效。独立服务还可在现有设置中配置该免费车道的代理列表。修改进程环境后需要重新启动服务。

## 登录控制台与管理令牌

在同一台机器打开终端打印的管理链接。链接中的临时凭证位于 URL fragment，10 分钟内有效且只能兑换一次。兑换后网页移除临时凭证，并使用 HttpOnly、SameSite=Strict 管理 Cookie；退出或重启服务会清除服务端会话。

链接过期或已使用时，优先通过登录页的本机取令牌入口，或从**当前实际数据目录**的 `settings.json` 读取 `managementKey` 登录。Windows / macOS 的按钮执行固定本机终端动作；Linux 可按页面手动说明获取。自定义数据目录请以启动参数为准，不要误读默认目录中的另一份配置。

三个密钥用途不同：

| 字段 | 用途 |
| --- | --- |
| `managementKey` | 本机管理登录令牌；登录后可访问需要特权管理会话的功能 |
| `forwardKey` | 本机模型 API 的 Bearer 密钥；不要把它当作完整管理权限令牌 |
| `standaloneLanKey` | 显式开启 LAN 推理中继后供局域网客户端使用的独立密钥 |

当前实现仍允许 `forwardKey` 建立兼容管理会话或调用部分普通管理接口，但涉及模型工作台、资源库、供应商、订阅、路由、引擎、插件等特权管理功能时，要求使用一次性链接或 `managementKey` 建立的管理会话。管理 Cookie 不能用于模型推理；`managementKey` 也不是推理 API Key。

## 接入模型 API

在控制台选择渠道并查看当前模型清单。账号渠道需要完成各自登录；EAC 在自己的页面授权。导入账号备份是手动操作，备份中可能含明文凭据。

使用终端打印的本机地址，加上 `/v1` 作为 OpenAI 兼容 API base URL。API Key 使用当前数据目录的 `forwardKey`，或在已登录控制台的「API 接入」页面主动查看。

例如在 PowerShell 中，先将实际密钥设为当前终端的 `OFM_API_KEY`，再请求模型清单：

```powershell
curl.exe "http://127.0.0.1:18900/v1/models" -H "Authorization: Bearer $env:OFM_API_KEY"
```

将端口替换成实际端口。Chat Completions 使用 `POST /v1/chat/completions`，Responses 使用 `POST /v1/responses`；模型 ID 应逐字复制当前清单。仅检查服务存活可访问无需凭据的 `GET /health`，它不证明各模型上游可用。

## 可选：局域网推理

管理页面和管理 API 始终只允许本机回环访问。需要其他设备推理时，在本机显式开启独立 LAN 中继：

```powershell
npm run start:standalone -- --lan --lan-port 18901
```

LAN 客户端使用控制台提供的独立 LAN Key，不应获取本机 `forwardKey` 或 `managementKey`。`--lan-port` 单独使用只保存端口，不会启用中继；默认期望端口为 0，以实际 LAN 地址为准。`--no-lan` 关闭并保存设置。

中继仅转发允许的模型与推理路径，不转发管理页。管理接口可在已鉴权后通过 `GET /api/management/lan/key` 读取 LAN Key；轮换要求 `POST /api/management/lan/key/rotate` 的请求体恰好为 `{"confirm":true}`。只向可信客户端分发 LAN Key，并按需要限制防火墙来源。没有通过 `--host`、`OFM_ALLOW_NON_LOOPBACK` 或容器端口映射开放管理页的支持。

## 常见问题与退出

| 现象 | 检查方法 |
| --- | --- |
| Node 版本或 `--env-file` 报错 | 用 `node -v` 核对完整版本及 `engines.node`；确认命令由预期 Node 执行 |
| 管理登录后部分功能被拒绝 | 使用一次性管理链接或 `managementKey` 重新登录，不要只使用推理密钥 |
| 推理返回 401 | 检查实际端口与 `Authorization: Bearer <forwardKey>`；LAN 改用独立 LAN Key |
| 免费车道提示缺少 Bun | 安装 Bun，或设置有效的 `OUR_FREE_MODEL_BUN` 后重启；这与账号登录是否成功无关 |
| 页面有 `networkMode: fixture` 提示 | 当前进程使用测试替身；不要将测试账号、响应或额度当成真实数据，也不要在此进程登录真实账号 |
| 模型清单为空或模型无输出 | 首次清单在后台加载；检查对应渠道与出网错误。目录条目和 HTTP 200 均不保证已有正常正文 |
| 不希望启动时刷新 | 使用 `--no-refresh`；手动刷新和推理仍可用，账号渠道自身的登录、续期与签到任务不因此全部停用 |
| `--probe` 没有自动探测 | 该参数仅保留兼容，当前不会据此自动发送探测请求。手动探测和模型测试会发送真实请求并消耗额度 |
| LAN 无法连接 | 核对 `running`、实际中继端口、防火墙及 LAN Key；管理页不会通过中继开放 |
| 报 `EEXIST` 或锁归属无法确认 | 先检查已有服务、数据目录及 `service.lock` 记录。不要删除仍有进程使用、权限不足或归属不明的锁；Windows/Linux 只自动回收可确认旧进程已退出且文件未被替换的锁 |

在启动服务的终端按 `Ctrl+C` 正常退出。服务会关闭监听与任务，并清理自己拥有的锁。统计主要保存用量和性能；提示词仍会发送至所选上游，敏感内容和所有密钥均应妥善保管。

维护或修改代码后，可按 [独立服务说明中的验证流程](../packages/standalone/README.md#验证) 执行专项测试。离线替身测试通过，不代表外部真实账号登录或实时上游服务已经验收。
