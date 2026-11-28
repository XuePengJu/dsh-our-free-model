# 第三方来源对照

本文件记录当前源码树能够核对的来源入口与历史关系。它不把名称相同、行为兼容、文件改写或测试通过直接等同于任何法律结论，也不把针对旧版本的逐字比较结果套用到当前文件。

## 当前可复核记录

| 当前文件或范围 | 来源与条款记录 | 当前可复核依据 | 边界 |
| --- | --- | --- | --- |
| `src/o2a/assets/ofm-agent-context.txt`、`ofm-tool-contracts.json` | 当前生成资产来自 `sst/opencode`（MIT）；历史请求适配参考 opencode2api（GPL-3.0） | `scripts/build-o2a-assets.mjs`、`docs/opencode-assets.md`、`src/o2a/SYNC.md` 记录 tag、生成方法与历史替换 | 资产名未变不表示仍是旧资产；不沿用旧 PR 的 929 B/13 条逐字比较结论 |
| `src/o2a/toolshape.js`、`tool-renames.js` 与其发布 bundle | opencode2api 是历史移植来源；当前正在替换 | `src/o2a/SYNC.md` 记录接触过历史源码、源模块与 `src/o2a.js` 的生成关系及尚未完成发布验收 | 不作 clean-room 声明；没有在本次核验中重做逐函数版权比较 |
| `src/token-saver/compact/` | RTK CLI（Apache-2.0）是历史参考，保留输出标记与阈值 | `docs/verification/2026-11-18-independent-core.md` 记录替换范围；旧 `src/token-saver/rtk/` 路径已不存在 | 不把旧常量顺序/行数比较用于现目录；不据重写记录断言义务消失 |
| `src/local-optimize.js` | free-claude-code（AGPL-3.0-only）是历史参考 | 替换记录及当前源文件保留的接口、优先级、配置键可检查 | 未在本次核验中重做完整上游差异分析 |
| `src/providers/registry.json` | models.dev（MIT）与历史 free-claude-code 目录参考等 | 每条 `source`/`notes` 及 `docs/provider-compatibility.md`、`docs/plans/provider-evidence.md` 区分目录数据与手工兼容记录 | 不能把整个目录称为由当前官方资料独立重建；旧 ID/条目交集本身不是法律判定 |
| `src/engine-parts/*.part` | `yetone/magpie`，上游声明 MIT；Go 依赖条款单列 | `vendor/magpie/engine.json` 指定 upstream、revision、构建参数、补丁与二进制/分片哈希；`scripts/build-magpie-engine.mjs` 给出构建路径；`vendor/magpie/LICENSE` 与 `NOTICE.md` 保留条款 | 当前上游源码入口已知，不应再标成「未提供/未知」；本次没有重建或验证 Windows 数字签名 |
| 本地 Magpie guard patch | OFM 对钉住 Magpie revision 的本地修改 | `scripts/magpie-engine-patches/0001-agent-sync-skip-an-empty-catalog.patch` 的完整原始字节也嵌入已随包分发的 `vendor/magpie/NOTICE.md`；SHA-256 与 `engine.json` 一致 | 补丁可审计不等同于已独立复现整份二进制 |
| `vendor/channel-pack/` | dsh-providers-hub（MIT）及其中单独记录的来源 | `vendor/channel-pack/LICENSE` 与 `NOTICE.md`；Qoder auth WASM 的未决分发依据另见根 `LICENSE` | 不从渠道包整体许可推断每个未决二进制的许可已经解决 |

## 许可证文本如何随包提供

- `LICENSES/GPL-3.0.txt` 与 `AGPL-3.0-only.txt` 是导入 PR #867 时保留的完整文本；同样的字节附于根 `LICENSE`。
- `LICENSES/Apache-2.0.txt` 保留独立副本；完整 Apache-2.0 正文也已存在于随包分发的 `vendor/magpie/NOTICE.md`。
- 根 `LICENSE`、两个 vendor 的 `LICENSE` 与 `NOTICE.md` 均在 `package.json` 的发布文件集合中。`LICENSES/` 本身目前不在该集合，故不能只依赖该目录把文本交付给 npm/Release 接收者。
- 原有版权、许可与历史来源通知保留。补充许可文本不改变 OFM 自写代码的 MIT 授权，也不替代针对具体历史制品的来源核对。

## 仍需独立核对

历史版本需要按具体 tag/制品核对来源、修改、生成资产、依赖与所需构建输入。上游 URL、当前源码与本次附带的许可文本不能单独证明每个历史版本的完整对应源码已经交付。当前二进制的独立可复现构建与签名状态、Qoder auth WASM 的分发依据也不在本次静态核验的已完成范围内。
