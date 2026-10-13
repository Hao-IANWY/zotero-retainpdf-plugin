# AI 问答摘除施工清单

> 状态：**已全部完成**（六阶段全落地）· 2026-10-11 立项，2026-10-12 收口
> 决策依据：[ADR 0006](../../adr/0006-remove-ai-chat.md)。本文是其第 3 节的落地打勾版，
> 范围以 ADR 为准，本文只管执行与验收。

## 1. 目标

产品收敛为"翻译引擎 + 图书馆"最小核心。全部完成后：

- 后端常驻服务只剩 rust_api 与 retain-jobsd
- 契约目录无 ai-* / public-document-operation / runtime-config / agent-calculation
- 前端无 ask / fx-terminal，reader 无内嵌聊天
- 文档与部署配置无 AI 入口残留

## 2. 分段施工清单

按 Rust → Python → 契约 → 前端 → 文档 → 部署推进，每段独立提交、独立收口。

### 阶段 1：Rust API（收口：cargo test --workspace + 架构门禁）—— ✅ 已完成（2026-10-11）

- [x] 删 `backend/api/src/routes/ai_proxy.rs`、`ai_terminal.rs`
- [x] 删 `backend/api/src/app/router/ai.rs`，撤 `server.rs` 装配
- [x] 删 `backend/api/src/services/ai/`（api.rs、gateway.rs）
- [x] 删 `backend/api/src/runtime/ai_supervisor.rs`（jobsd_supervisor 保模式不保文件）
- [x] documents 路由摘 `agent-versions` 端点
- [x] `retain-core`：删 `config/ai_service.rs`、`models/view/reader_ai.rs`，清 `view.rs` / `models.rs` / `api.rs` 引用
- [x] api_tests：删 `ai_proxy.rs`、`ai_terminal.rs`、`public_document_operations.rs`、`jobs_reader/one_ai_door.rs`；收缩 `credentials.rs`、`library_data.rs` 中的 AI 断言
- [x] 架构检查通过（无 AI 专属规则需要删除，门禁一次通过）
- [x] 核对 `job-events.v2` / `library-books.v1`：无 AI 专用字段，幸存契约不动；5 个专属 schema 留阶段 3 删

**执行期范围修正**（实测足迹大于 ADR 表格，均属 AI 子系统，一并摘除）：

- 路由层追加：`routes/agent_calculations`、`agent_capabilities`、`agent_runtime_sessions`、`document_operations`、`library_extras`（会话/资产路由）、`common/` 下同名四个、`app/router/internal_agent.rs`（AI 服务内部回调 API `/internal/agent/*`）
- 服务层追加：`agent_capability_api`、`agent_runtime_session_api`、`document_operation_api`、`library/{conversations,assets}`
- retain-core 追加：`config/ai_proxy.rs`、`config/reader_llm.rs`、`config/rag.rs`
- 其他：`auth.rs` 的 `x-retainpdf-agent-capability` 能力头分支、credentials 的 `ai_runtime_references_credential` 保护分支、`examples/query_acceptance.rs` 与若干测试内配置字段

**保留判定**（查证后确认不属于 AI 问答，避免误伤）：

- `failure_ai_diagnosis`（retain-jobs）：用翻译 provider 的模型诊断任务失败，不依赖 backend/ai
- `model_executor` / `model_requests`：翻译 worker 的模型调用设施
- `collection_agent_workspace`（library/reading）：合并阅读功能，"agent"只是命名
- `AssetConfig`：library 媒体与 jobs downloads 共用

**验收**：`cargo check --workspace` 0 警告 0 错误；`cargo test --workspace -j 2 -- --test-threads 2` 全绿（551 项）；架构门禁通过。注：默认并行度下 9 个计时型测试（model_executor/上传修复/凭据围栏）在本机负载下会抖动，单测与降并行均通过，与本次改动无关。

### 阶段 2：Python 服务（收口：workspace 可解析、无悬挂 import）—— ✅ 已完成（2026-10-11）

- [x] 删 `backend/ai/` 整目录
- [x] `backend/pyproject.toml` workspace 摘 ai 成员，`uv lock` 重生成
- [x] 全仓 grep `retainpdf_ai|backend/ai` 清残留引用（部署/外围引用留阶段 6）

**执行期范围修正**（同为 AI 子系统，一并摘除）：

- pipeline 侧：`retainpdf_pipeline/document_operations/` 包、`entrypoints/run_document_operation.py`、
  console 的 `document-operation` 子命令、`devtools/architecture_checks/document_operations.py` 及挂载、
  相关测试四处（含 recovery 边界参数化项、Windows 导入回归项）
- Rust 补遗（阶段 1 漏网的 agent 工作区族）：
  - 下载服务：`downloads/{ai_board,ai_carryover}` 及测试；`reading-path`/`canvas`/`board` 三组路由；
    `DocumentDownloadKind` 的 AiReadingPath/AiCanvas 变体与接力逻辑
  - 路径层：`storage_paths` 的 4 个 `resolve_ai_*`、`OUTPUT_AI_DIR_NAME` 与 AI 文件名常量、
    `MergedJobId::ai_dir`
  - **`services/collection_workspace`**（collections 的 `agent-workspace` 端点）——初判误留为
    "合并阅读"，复核其自述后确认是给 AI 服务的物化工作区，已删
- 修正判定：`collection_agent_workspace` 归 AI（阶段 1 的"保留判定"作废此条），
  人类阅读走的 `/documents/{id}/reading` 不受影响

**验收**：`uv run --extra test pytest pipeline/devtools/tests` 2370 过；`cargo test --workspace -j 2`
全绿；rust_api 与 pipeline 两道架构门禁均通过。

### 阶段 3：契约（收口：check_parity 通过）—— ✅ 已完成（2026-10-11）

- [x] 删 5 个 schema：`ai-ask.v1`、`ai-conversations.v1`、`public-document-operation.v1`、`runtime-config.v1`、`agent-calculation.v1`（上游包与 backend 镜像双侧同步删）
- [x] `check_parity.py` 收缩对应规则

**连带收缩**：contracts 包的 `package.json` exports、`lint-schemas.mjs` 清单、
`package-boundary` 测试、`runtime-and-operation-contract` 测试（删）、
前端 `ai-ask/ai-conversations` 两个契约测试（删）、两份 contracts README、
`api/docs/api-spec/` 的 ai-control-plane 与 agent-document-operations 两篇（删）、
jobs-document-history 的 agent-versions 段。

**验收**：`check_parity.py --require-upstream` 字节级一致；`npm --prefix contracts test`
17 项全过。`backend/api` 三份规格文档（README / API_SPEC / CURRENT_API_MAP）的残留
引用留阶段 5 统一收口。

### 阶段 4：前端（收口：web typecheck/build/test 通过）—— ✅ 已完成（2026-10-11）

- [x] 删 `frontend/web/src/features/ask`、`features/fx-terminal`
- [x] reader（`frontend/packages/reader`）摘内嵌 AI：shared/ai 全目录、runtime/ai、
  components/ai 六组件、宿主槽位面板机制（terminal/board 壳与适配器类型，槽位表清空保留机制）、
  ReaderAppReactPdf 的 board/终端上下文、AI 导航锁与 window guard
- [x] platform 层：`@retainpdf/api` 删 ai/conversations/agent-runtime-settings/
  document-operations/agent-operation-model 五模块；web platform/api 同名四域 + mocks；
  credentials 删 AgentRuntime 卡片三件套（**凭据工作台本体保留**）；book-detail 产物中心删 agent 分组；
  导航/顶栏/返回状态/CSS 入口去 AI 问答 tab 与样式
- [x] 测试面：删 AI 测试文件 8 个（ask/fx-terminal/answerer/board/panel 等），
  修剪契约门禁（launcher 面板下限、restore seeds terminal→markdown、boundary 导出表、
  CSS 指纹断言、HomeApp 分栏断言）
- [x] contracts 包依赖收缩：reader 包去 ai/@ai-sdk/@assistant-ui/markstream-react 四依赖

**验收**：`tsc --noEmit` 0 错误；reader 包 vite/tsc/styles 三关过；web 测试 1586 项，
环境性失败 2 项与本改动无关（topbar-hit-test 需 Playwright 浏览器二进制；
config-resolution 依赖本机 gitignored 的 runtime-config.local.js 内容格式）。

### 阶段 5：文档（收口：docs 内 grep `ai/ask|ai-runtime|reader-ai` 无活引用）—— ✅ 已完成（2026-10-11）

- [x] 删 `docs/core/ai-runtime/` 整目录、`docs/core/api/reader-ai-chat.md`
- [x] api README 删"AI 问答与 PDF operation"分区与快速入口、agent-versions 行
- [x] core/api/index 与 README、backend ARCHITECTURE（整体重写去 AI 服务/拓扑/契约行）、
  repository-layout、根 README、local-dev、python README 与依赖真相源、
  frontend/library-api（资产+AI 会话两章）、产物下载总览、status_smoke
- [x] backend 规格：API_SPEC / CURRENT_API_MAP（§12 整节）/ RUST_API_ARCHITECTURE /
  RUST_API_DIRECTORY_MAP / README / api-spec 的 jobs、reader-read-model、storage-and-errors
- [x] ADR 0006 状态待阶段 6 全部落地后终标（当前 1–5 已完成）

**验收**：当前真值层（docs 核心 + backend/api 规格 + 根 README）grep
`ai-runtime|reader-ai|AI 问答|/api/v1/ai/|retainpdf-ai|/api/v1/assets|agent-versions`
零命中；ops 规划/报告/问题层按治理规则保留历史原文。

### 阶段 6：部署与配置（收口：本地起栈冒烟）—— ✅ 已完成（2026-10-12）

- [x] `ops/development/dev_stack.py` 去 retainpdf-ai：ai 端口、runtime 参数、preflight_fx、
  RETAIN_AI_*/RUST_API_AI_* 全部环境注入；配套测试重写（43 项全过）
- [x] Docker：Dockerfile.app 删 backend/ai 构建层、fx 二进制下载与校验段、8 条 AI ENV、
  retainpdf-agent 拷贝；entrypoint-app.sh 删 fx 预检与 AI state 目录；README 收缩
- [x] 桌面装配：main.js 去 AI 服务探测/拉起/端口分配槽/关停链；backend-env.js 去 AI env 段；
  prepare-app.mjs 去 ai_service 与 agent 二进制打包；requirements-ai-service.txt 删除；
  windows-live-smoke 去 AI runtime 探针；端口分配器去 aiServicePort 槽
- [x] CI 与发布：tests.yml / build-desktop-packages.yml 去 ai 依赖安装与 import 检查；
  sync_backend_python_requirements 去 ai 源；check_standalone / build_source_archive 收缩；
  根 package.json 去 verify:ai；tests/e2e/agent 整目录删除
- [x] env 检查：本机 skip-worktree 的 delivery env 无 AI 变量，无需清理
- [x] jobs-control.v1 契约的 semantics 字段去 retainpdf-ai 提及（双侧字节级同步）

**验收**：cargo test --workspace 全绿（-j2，个别计时型测试单测复验通过）；
dev_stack 测试 43/43；CI 脚本测试 200/201（1 项既有失败与本次无关，stash 验证）；
contracts parity 字节级一致；entrypoint/prepare-app/main.js 语法检查通过。

## 3. 已知坑（来自 0005 的实测经验）

| 坑 | 应对 |
|---|---|
| `auth.local.json` 优先于 `RUST_API_KEYS` | 冒烟前先确认钥匙来源 |
| 架构门禁是文本扫描，注释里出现越界词也判红 | 改措辞，不放宽门禁 |
| env 被 skip-worktree 锁定 | 摘除后 git diff 看不到 env 变化，属预期 |
| credentials 是翻译共用服务 | 只摘 AI 分支引用，服务本身保留 |
| 数据库 conversations / operations 历史表 | 不迁移不清洗，随服务下线成为死数据（ADR 0006 裁决） |

## 4. 回滚

每阶段一个提交。任一阶段出问题 `git revert` 该段提交即可；阶段间无 schema 迁移，无连环依赖。
