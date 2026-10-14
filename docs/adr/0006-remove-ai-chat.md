# 0006 移除 AI 问答，产品专注文献翻译

> 状态：已执行（2026-10-11 采纳，2026-10-12 六阶段全部落地，见 ops/planning/completed/ai-chat-removal.md）。
> 触发动机：产品定位收敛——retain-pdf 的核心价值是排版保留的文献翻译，
> AI 问答（阅读器整本问答、PDF operation、fx-terminal）是旁支，且贯穿全栈，
> 每条主线改动都要为它支付兼容与维护成本。

## 1. 背景

AI 问答是一条完整旁路链路：前端 `features/ask`、`features/fx-terminal` 与
reader 内嵌聊天 → Rust 壳 `routes/ai_proxy.rs`、`ai_terminal.rs`、
`services/ai/`、`runtime/ai_supervisor.rs` → Python 服务 `backend/ai/`
（retainpdf-ai :41100）→ 独立契约（ai-ask.v1、ai-conversations.v1、
public-document-operation.v1、runtime-config.v1、agent-calculation.v1）。
它还把 `documents/{id}/agent-versions` 挂进了文档路由，把 ai 服务写进了
dev 脚本、桌面装配与容器拓扑（见 [0005](./0005-shell-and-backends.md) 的进程组图）。

产品目标重定为：**单一任务——文献翻译**（OCR → 翻译 → 排版保留渲染 → 产物）。
Zotero 插件化（[0007](./0007-own-zotero-plugin.md)）进一步要求服务端形态简洁、部署面小。

## 2. 决策

整体移除 AI 问答全链路：Rust 代理与监督、Python 服务、五个契约 schema、
前端 feature 与内嵌 UI、文档与部署配置、相关 env 变量。

边界裁决：

- **保留 `credentials` 服务**——翻译链路的 provider API key 同样走它
  （`translation.credential_ref`），只摘除 AI 分支引用。
- **OCR / 翻译 / 渲染主线不动**——OCR 是扫描文献进入翻译链路的必要环节。
- 会话与 operation 历史数据随服务下线废弃，不做迁移。

## 3. 摘除范围（施工基准，已按此执行）

| 层 | 内容 |
|---|---|
| Rust API | `routes/ai_proxy.rs`、`routes/ai_terminal.rs`、`router/ai.rs`、`services/ai/`、`runtime/ai_supervisor.rs`、documents 路由 `agent-versions`、相关 api_tests、`retain-core` 的 `config/ai_service.rs`、`models/view/reader_ai.rs` |
| Python | `backend/ai/` 整目录、workspace pyproject 挂载 |
| 契约 | ai-ask.v1 / ai-conversations.v1 / public-document-operation.v1 / runtime-config.v1 / agent-calculation.v1，`check_parity.py` 同步收缩 |
| 前端 | `features/ask`、`features/fx-terminal`、reader 内嵌聊天、settings 的 runtime-config 页 |
| 文档 | `docs/core/ai-runtime/`、`docs/core/api/reader-ai-chat.md`、api README AI 分区、repository-layout、根 README |
| 部署 | compose / dev 脚本 / 桌面装配中的 ai 服务与监督、env 中 AI 变量 |

摘除按 Rust → Python → 契约 → 前端 → 文档 → 部署分段推进，每段以
`cargo test --workspace` + 架构门禁 / 前端 build 收口。
注意：env 文件被 skip-worktree 锁定，清理变量后 git status 不显示改动属正常。

## 4. 后果

- 阅读器问答能力消失；conversations / operations 数据成为死数据，接受。
- 部署面缩小一个常驻服务；0005 进程组图中 retainpdf-ai :41100 与
  ai_supervisor 相关注记随之过时。
- 若未来恢复，git 历史可回溯代码，但契约与数据结构无迁移路径，重建即重写。
- 本决定使仓库收敛为"翻译引擎 + 图书馆"的最小核心，与 0007 的
  插件化形态互为前提。

## 5. 替代方案

- **保留但冻结（feature flag 关闭）**：死代码持续腐化、门禁与测试仍要养，
  违背"简洁"目标，否决。
- **拆出为独立服务/仓库继续养**：为不再使用的能力维持分发与维护义务，否决。
