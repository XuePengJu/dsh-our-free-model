# 第三方许可证与源码入口

根 `LICENSE` 开头的 MIT 授权覆盖 OFM 自己写的代码；第三方组件保留各自条款和通知。本目录收录独立许可文本与来源记录，供源码接收者核对。

`LICENSES/` 目前没有列入 npm/Release 的 `package.json.files`。因此 GPL-3.0 与 AGPL-3.0-only 的完整文本也附在已随包分发的根 `LICENSE` 中；Apache-2.0 完整文本随 `vendor/magpie/NOTICE.md` 分发。不能把「仓库有文本」当成「安装包已含该目录」。

| 组件 | 上游 | 许可证 | 本仓库中的落点 | 全文 |
| --- | --- | --- | --- | --- |
| free-claude-code | https://github.com/Alishahryar1/free-claude-code | AGPL-3.0-only | 历史供应商目录与本地应答来源（`docs/provider-compatibility.md`） | `AGPL-3.0-only.txt`；根 `LICENSE` 同时收录 |
| opencode2api | https://github.com/jasonxu114514/opencode2api | GPL-3.0 | 历史免费车道请求整形来源（`src/o2a/SYNC.md`） | `GPL-3.0.txt`；根 `LICENSE` 同时收录 |
| rtk | https://github.com/rtk-ai/rtk | CLI Apache-2.0 / engine BUSL-1.1 | 工具输出压缩的历史参考（`docs/verification/2026-11-18-independent-core.md`） | `Apache-2.0.txt` |
| models.dev | https://github.com/anomalyco/models.dev | MIT | 模型窗口、输出上限与思考档位数据 | 见根 `LICENSE` 内附版权与全文 |
| dsh-providers-hub | https://github.com/iJetLi/dsh-providers-hub | MIT | `vendor/channel-pack/` | `vendor/channel-pack/LICENSE` |
| sst/opencode | https://github.com/sst/opencode | MIT | 当前生成请求资产（`docs/opencode-assets.md`） | 根 `LICENSE` |
| Magpie | https://github.com/yetone/magpie | MIT；Go 依赖条款单列 | 钉住 revision 的本地构建及 guard patch | `vendor/magpie/LICENSE` 与 `NOTICE.md` |
| 9router / trae-mate / dsh-cline-pass | 见根 README「致谢」 | MIT | 目录与流程参考 | 以各上游 `LICENSE` 为准 |

## 源码入口与获取边界

当前 OFM 源码在本仓库；具体已发布版本应使用对应 tag/提交，而不是只看不断变化的主分支。历史参考项目的源码入口列于上表；本仓库 Git 历史、`src/o2a/SYNC.md`、`docs/provider-compatibility.md`、`docs/verification/2026-11-18-independent-core.md` 与 [PROVENANCE.md](PROVENANCE.md) 记录了替换和兼容范围。需要某个历史制品的来源或构建输入时，可在本仓库开 issue，提供版本、平台及制品哈希，以便定位。

这些是可核验的源码指针，不把上游首页、当前源码或一次重写说明自动等同于某个历史二进制的完整 Corresponding Source。针对具体版本需要的修改、依赖、生成步骤和构建输入仍需逐项核对；本次没有作出相反的合规结论或未经证实的源码交付承诺。

## 历史制品

本记录供 v2.8.5 及更早版本的接收者追溯历史来源。本次补充不改变那些已发布文件的内容，也不能追溯地把本目录放进旧安装包。历史制品是否随附完整条款及对应源码，需要按该制品本身继续核验。
