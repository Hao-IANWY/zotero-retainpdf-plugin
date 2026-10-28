# 上游补丁回移清单（2026-10-28）

状态：P0 三条 + P1-4/P1-5/P1-6a/P1-7/P1-8 已完成（2026-10-28），P2 待排期
来源：`upstream`（wxyhgk/retain-pdf）main，基线 `a72b544`（2026-10-08 +0800）

## 背景

本仓库是 squash 快照起步，与上游**无共同祖先**，`git merge` / `cherry-pick` 都不可用；
本清单是逐条核对后的**手工回移**方案，每条都自带测试点。

上游自基线起有 1030 个提交（实质 558），其中 417 个动到我们仍保留的文件。
整体评估见会话结论；这里只收"对我们现在的部署有直接收益、且相对独立"的条目。

布局映射（回移时按这张表找落点）：

| 我们 | 上游当前 |
|---|---|
| `backend/api/src/**`（单 crate `rust_api`） | `backend/api/src/**` + `backend/packages/retainpdf-{api-base,ingest,files,library,...}` |
| `backend/packages/retain-{core,data,jobs,proc}` | `backend/packages/retainpdf-*` |
| `database/retain-db` | `database/retainpdf-db` |
| `backend/api/src/services/derived_artifacts` | `backend/packages/retainpdf-files/src/derived_artifacts` |
| `backend/pipeline/retainpdf_pipeline/translate/llm` | `backend/translation/retainpdf_translation/llm` |

---

## P0-1 500 只回编号，原因进日志 ✅ 2026-10-28

- 上游：`be3c459`（2026-10-13）
- 问题：我们 [error.rs:445](../../../backend/api/src/error.rs#L445) 的 `IntoResponse` 对 `Internal` 直接
  `message: self.to_string()`，把底层 anyhow 文案（服务器路径、SQL、上游返回）回给调用方。

步骤：

1. 在 [error.rs](../../../backend/api/src/error.rs) 加 `log_internal_error(detail) -> String`
   （时间戳 + AtomicU32 计数，`tracing::error!(error_id, ...)`）。
2. `IntoResponse` 的兜底分支按变体分流：`AppError::Internal(detail)` →
   `message: "internal server error (ref {id})"`，
   `error: StructuredError::with_details(code, status, json!({"error_id": id}))`；
   其余变体保持原样。`StructuredError::with_details` 已有（[error.rs:155](../../../backend/api/src/error.rs#L155)）。
3. `From<anyhow::Error>` 改成 `format!("{value:#}")`，让日志带整条原因链。
4. 更新 [error.rs](../../../backend/api/src/error.rs) 里断言 `Internal` 原样的用例表。

测试：移植 `internal_error_hides_detail_behind_reference`（断言响应里不含内部路径、error_id 两次不同）。

坑：只影响 `rust_api`；jobsd 的错误信封在 `backend/jobs/src/main.rs`，不在这次范围。

估算：半天内（S）。

---

## P0-2 API key 常量时间比较 + 请求日志不记查询串 ✅ 2026-10-28（日志只做了一半，见下）

- 上游：`38280a3`（2026-10-24）
- 现状：[auth.rs:17](../../../backend/api/src/auth.rs#L17) 用 `HashSet::contains`；
  [jobs main.rs:57](../../../backend/jobs/src/main.rs#L57) 同写法；
  两根 `TraceLayer::new_for_http()`（[router.rs:34](../../../backend/api/src/app/router.rs#L34)、[router.rs:44](../../../backend/api/src/app/router.rs#L44)）
  默认 span 记整个 URI。

步骤：

1. [retain-core/config/auth.rs](../../../backend/packages/retain-core/src/config/auth.rs) 加
   `api_key_matches` + `bytes_equal_in_constant_time`（逐字节 XOR、`black_box`），附单测
   （空集合谁都不放、长度不同不等）。
2. [auth.rs:17](../../../backend/api/src/auth.rs#L17) 改用 `api_key_matches`；
   [jobs main.rs](../../../backend/jobs/src/main.rs#L57) 同改。
3. 请求日志只记 method + path（建议与 P1-5 合并做，见下）。

本轮已落地 1、2；第 3 条留到 P1-5 一次性替换 `request_log.rs` 时做（同一段代码不写两遍）。

**不要照搬的部分**：上游同时让 jobsd 在 `api_keys` 为空时**谁都不放**。我们当前是匿名模式
（`RUST_API_KEYS` 未配置时 [state.rs:50](../../../backend/api/src/app/state.rs#L50) 给 jobsd 下发空 key），
照搬会让 rust_api → jobsd 的内部调用全部 401。本轮只换比较方式、保留空集合放行，
并在 [jobs main.rs:56](../../../backend/jobs/src/main.rs#L56) 写了注释说明原因；要收紧得先加
"匿名模式下随机生成一把内部 key"的机制——这是老板拍板项，不是纯技术移植。

测试：`config::auth::tests::api_key_matches_only_exact_configured_keys` 已加；
查询串不进日志的断言随 P1-5 补。

估算：半天内（S）。

---

## P0-3 建任务的数字参数加上限 ✅ 2026-10-28

- 上游：`6fc528a`（2026-10-24）
- 现状：[job_validation.rs](../../../backend/api/src/services/job_validation.rs) 只查下限；
  `workers=100000` 能一路传给 Python 线程池。

步骤：

1. 常量：`MAX_TRANSLATION_WORKERS=256`、`MAX_TRANSLATION_BATCH_SIZE=1000`、
   `MAX_RENDER_COMPILE_WORKERS=64`、`MAX_RENDER_PDF_COMPRESS_DPI=1200`、
   `MAX_RUNTIME_TIMEOUT_SECONDS=7*24*3600`。
2. 在 [validate_translation_modes:150](../../../backend/api/src/services/job_validation.rs#L150)、
   [validate_render_options:174](../../../backend/api/src/services/job_validation.rs#L174)、
   [validate_runtime_limits:259](../../../backend/api/src/services/job_validation.rs#L259) 里逐字段查。
3. 新 helper `validate_at_most`（挨着 [validate_positive_finite:408](../../../backend/api/src/services/job_validation.rs#L408)）。
4. 字段在 [translation.rs](../../../backend/packages/retain-core/src/models/input/translation.rs#L93)、
   [render.rs](../../../backend/packages/retain-core/src/models/input/render.rs#L20)、
   [runtime.rs](../../../backend/packages/retain-core/src/models/input/runtime.rs#L11)，名字与上游一致。

测试：在 [job_validation/tests.rs](../../../backend/api/src/services/job_validation/tests.rs) 各加"超上限 400 / 等于上限通过"。

估算：1 小时内（S）。

---

## P1-4 磁盘剩余空间门禁 ✅ 2026-10-28

- 上游：`45950bb`（2026-10-24）
- 现状：完全没有。磁盘写满后 SQLite 提交失败、worker 写不出产物，任务成批失败且事先无预警。

**落地说明**：门禁放在 `start_job_execution`（所有建任务路径的公共出口，落库之前）与
`rerun_submission` 开头（原地重渲染删旧产物之前），上传走 `UploadService::ensure_free_space`；
`AppError` 新增 `Reasoned { status, reason, message }` 变体，信封与普通 503 一致、只多
`error.details.reason`。`RUST_API_MIN_FREE_DISK_MB` 已写进 [local-dev.md](../../core/api/local-dev.md)
与交付 `app.env` 注释。

步骤：

1. 新模块 `backend/api/src/services/disk_space.rs`：`free_space_bytes`（unix `libc::statvfs`，
   非 unix 返回 `None`）、`ensure_free_space(path, min, what)` → 503 + `reason=insufficient_storage`。
2. `AppError` 加一个带 `reason` 的 503 变体（我们没有上游的通用 `Reasoned`；
   仿 [DeleteBlockedByFavorites](../../../backend/api/src/error.rs#L104) 的写法，
   响应体 `error.details.reason` 与前端约定对齐）。
3. 配置：[retain-core/config/upload.rs](../../../backend/packages/retain-core/src/config/upload.rs) 加
   `RUST_API_MIN_FREE_DISK_MB`（默认 1024，`0` 关闭），进 `UploadRuntimeConfig`。
4. 三处门禁：
   - 上传：[routes/uploads.rs:21](../../../backend/api/src/routes/uploads.rs#L21) 读请求体之前查一次；
     [uploads/service.rs](../../../backend/api/src/services/uploads/service.rs) 的 `store` 按 `2×文件大小 + 下限` 再查。
   - 建任务：[job_launcher.rs](../../../backend/api/src/services/job_launcher.rs) 的 `start_job_execution`
     （所有建任务路径的公共出口，落库之前）。
   - 原地重跑：[facade/command/rerun.rs](../../../backend/api/src/services/jobs/facade/command/rerun.rs) 开头，删旧产物之前。
5. `/health` 加 `disk { free_bytes, min_free_bytes, low }`
   （[health_api.rs:57](../../../backend/api/src/services/health_api.rs#L57) 的 `HealthView` + `HealthApiDeps`）。

测试：移植 `api_tests/disk_space.rs` 的思路（临目录 + 巨大下限 → 503、reason、/health 字段）；
注意我们 [api_tests/mod.rs](../../../backend/api/src/api_tests/mod.rs) 的注册方式。

坑：默认 1024 MiB，存量部署升级后如果数据盘本就紧张，会上传/建任务直接 503——发版说明要写，
需要时设 `RUST_API_MIN_FREE_DISK_MB=0`。

估算：半天（M）。

---

## P1-5 每个回应带 X-Request-ID + 访问日志 ✅ 2026-10-28

- 上游：`aa59944`（2026-10-24），依赖 `38280a3` 的 trace 改动
- 现状：没有请求编号；`TraceLayer` 默认 debug span 记整个 URI。

步骤：

1. 新增 `backend/api/src/app/request_log.rs`（上游同路径）：
   - `assign_request_id` 中间件：客户端带合法编号（≤64、可见 ASCII 子集）就沿用，否则 `{fastrand:016x}`；
     写回请求头 + 响应头 `X-Request-ID`。
   - `trace_layer()`：`request` span 记 method/path/request_id，**不记查询串**；
     `on_response` 里 ≥1s 记 info（target `rust_api::access`），否则 debug。
2. [router.rs](../../../backend/api/src/app/router.rs)：两处 `TraceLayer::new_for_http()` 换成 `trace_layer()`，
   并在**外层**（后加）`assign_request_id`。
3. 可选（P2）：job driver 加 `info_span!(parent: None, "job", job_id)`，
   落在 [retain-jobs/job_runner/lifecycle.rs:101](../../../backend/packages/retain-jobs/src/job_runner/lifecycle.rs#L101)。
4. 可选：nginx 访问日志加 `$upstream_http_x_request_id`（[nginx.conf.template](../../../ops/deployment/docker/nginx.conf.template)）。

**落地说明**：1–3 全部完成（driver span 一并做了）；第 4 条 nginx 访问日志格式未改，
需要时再加 `$upstream_http_x_request_id`。访问日志 target 用 `rust_api::access`。

测试：移植 `request_log.rs` 单测（编号合法性、生成 16 位）+ `api_tests/request_log.rs`
（响应头存在、沿用客户端编号、日志不含查询串）。

坑：`assign_request_id` 必须在 CORS 之外一层，否则跨域读不到响应头；上游的顺序是
CORS → trace → assign_request_id（assign 最外）。

估算：半天（M）。

---

## P1-6a 迁移 v29：启动时全表扫挪进迁移 + 老表补列加锁 ✅ 2026-10-28

- 上游：`25068c9`（v29）、`0e157ed`（补列加锁）
- 现状：
  - [state.rs:36](../../../backend/api/src/app/state.rs#L36) 每次启动调 `cleanup_legacy_workflows`，
    对 `events.payload_json` 做 `LIKE` 全表扫描（[db.rs:303](../../../database/retain-db/src/db.rs#L303)）。
  - 补列分在 [db.rs:259-295](../../../database/retain-db/src/db.rs#L259) 的 `connect()` 与 `init()`
    两处、不拿锁；rust_api 与 jobsd 同时升级老库时后到的报 `duplicate column` 起不来。

步骤：

1. 在 [schema.rs](../../../database/retain-db/src/db/schema.rs#L15) 的 `VERSIONED_MIGRATIONS` 末尾追加一条
   （三条 UPDATE：jobs.workflow、jobs.request_json、events.payload_json 的 `mineru`→`book`）。
   我们的版本号是图书馆表自己的阶梯，追加即可，编号不同于上游的 v29。
2. 删掉 `cleanup_legacy_workflows`（[db.rs:303](../../../database/retain-db/src/db.rs#L303)）与启动调用
   （[state.rs:36](../../../backend/api/src/app/state.rs#L36)）。
3. 补列收成一张 `LEGACY_COLUMNS: &[(表, 列, 定义)]`（只收我们现在实际有的列，
   **不要**带 `run_generation` / `worker_identity`，那是状态一致性那一批的列），
   `ensure_legacy_columns`：先无锁 `PRAGMA table_info` 看一眼，缺了再 `TransactionBehavior::Immediate`
   里重查 + `ALTER`；`init()` 不再补列。

**落地说明**：三条 UPDATE 收进我们阶梯的 **v17**（不是上游的 v29，编号体系不同）；
`cleanup_legacy_workflows` 与启动调用已删除；补列收成 `LEGACY_COLUMNS` + `ensure_legacy_columns`
（无锁预检 → IMMEDIATE 事务内重查再加），`connect()` 与 `init()` 都走同一入口。

测试：`upgrading_to_v17_rewrites_legacy_workflow_rows_once`（原 `build_state_cleans_legacy_workflow_rows`
改造：装成 v16 → 启动改 `mineru`→`book`；再写一条 `mineru`，二次启动**不再**扫）；
`schema::tests::legacy_columns_are_completed_once_and_a_second_pass_is_a_noop`。

估算：半天（M）。

---

## P2-6b 升级前备份门禁 —— 暂不回移

上游 `0e157ed` 里的 `RUST_API_DB_REQUIRE_UPGRADE_BACKUP` 依赖整套备份子系统，
而备份/恢复是上游 `428e31d`（2026-10-09，feat(backup)）才引入的，我们**完全没有**
（`database/retain-db` 里没有任何 backup 模块）。

结论：单独搬门禁没有意义。要么整包搬备份/恢复（含设置页与每日任务，L），
要么只做 6a。建议先做 6a。

---

## P1-7 派生缓存定期回收 ✅ 2026-10-28

- 上游：`2758c1a`（2026-10-24）
- 现状：`artifacts/` 里的 Word、对照 PDF、线性化 PDF、页预览只增不减；
  我们的清理循环（[app/cleanup.rs](../../../backend/api/src/app/cleanup.rs)）只清 events 与孤儿上传。

步骤：

1. 先把缓存文件名收成函数（生成与回收共用）：
   - `{job_id}-side-by-side.pdf`：[side_by_side.rs:65](../../../backend/api/src/services/derived_artifacts/side_by_side.rs#L65)
   - `{job_id}-layout-{suffix}.docx`：[word.rs:59](../../../backend/api/src/services/derived_artifacts/word.rs#L59)
   - `{label}.linearized.pdf`：[pdf.rs:20](../../../backend/api/src/services/derived_artifacts/pdf.rs#L20)
   - 页预览：`derived_artifacts/previews.rs`（按现有文件名格式）
2. 新增 `derived_artifacts/retention.rs`：遍历**已终态**任务的 `artifacts/`，
   只删能按上述名字认出的缓存，按 mtime 超过保留天数删；跳过符号链接、在跑任务、
   管线自己写进 artifacts 的文件、封面缩略图。
3. 配置：[retain-core/config/cleanup.rs](../../../backend/packages/retain-core/src/config/cleanup.rs) 加
   `RUST_API_DERIVED_CACHE_RETENTION_DAYS`（默认 0 = 不清）。
4. 挂进 [cleanup.rs](../../../backend/api/src/app/cleanup.rs) 的周期清扫，整轮放 `spawn_blocking`。

**落地说明**：文件名收成 `side_by_side_file_name` / `layout_docx_file_name` / `linearized_file_name` /
`job_page_preview_file_name`（生成侧四个调用点已改用），新增 `derived_artifacts/retention.rs`；
`CleanupConfig` 未动，保留天数和其他 retention 设置一起放在 `RetentionSettings`（env 默认 0）；
`run_cleanup_once` 与两个 spawn 函数加了 `data_root` 参数，扫描在 `tokio::spawn` 的清理任务里执行。
文档：[local-dev.md](../../core/api/local-dev.md) 与交付 `app.env` 已加变量说明。

测试：`only_old_recognised_caches_are_removed`（新/旧各两种缓存 + 符号链接 + 管线产物 + 封面 + 陌生预览名）、
`invalid_job_ids_are_ignored`、`terminal_job_sweep_reaches_caches_but_skips_running_jobs`（DB 里一个终态、一个在跑）。

估算：1–1.5 天（M-L）。

---

## P1-8 翻译质量修复（4+1 条）✅ 2026-10-28（`004db26` 不适用，见下）

上游这几条**路径与我们一致**（`retainpdf_pipeline.translate.llm...`），可近似直接套：

| 上游 | 内容 | 我们的落点 | 备注 |
|---|---|---|---|
| `f6e30a2` | 自我纠正泄漏（模型把草稿 + Wait—… + 改好的译文一起交回） | 新 `validation/self_correction.py`；接 [result_validator.py:103](../../../backend/pipeline/retainpdf_pipeline/translate/llm/result_validator.py#L103) 与 [validation/quality.py:158](../../../backend/pipeline/retainpdf_pipeline/translate/llm/validation/quality.py#L158) | 该提交的测试 import 路径与我们完全一致，可直接搬 |
| `3925a8e` | 公式花括号不配对拦下修复 | [validation/math_safety.py](../../../backend/pipeline/retainpdf_pipeline/translate/llm/validation/math_safety.py) + `errors.py` + `quality.py` + `result_validator.py` | 独立，风险低 |
| `566af39` | 「部分接受」不再收下自言自语 + 抄的原文 | [direct_typst_salvage.py](../../../backend/pipeline/retainpdf_pipeline/translate/llm/shared/orchestration/direct_typst_salvage.py) + `self_correction.py` | 依赖 f6e30a2 先落地 |
| `004db26` | QA 三级以上节号不再误报「多出数字」 | 无落点 | **不适用**：快照里没有确定性 QA 报告子系统（`services/quality` 只有 `__init__.py`），要做得先搬 `feat(translate): translation_qa.v1` 整块 |
| `cf72687` | 逐段提示词「前后文 → 原文 → 最后一行作答要求」+ 拿不准时的自问自答判为错误 | [prompt_protocols.py](../../../backend/pipeline/retainpdf_pipeline/translate/llm/shared/prompt_protocols.py#L140)（`_append_context_lines`、`direct_typst_single_user_prompt:278`、`plain_text_single_user_prompt:310`） | **最容易冲突**，见下 |

`cf72687` 注意事项：

- 我们的文件正是它修改前的版本（`_append_context_lines` 还是「前文上下文：…」内联写法）。
- 上游中间还夹着 10-09 的提示词去重与 10-14 的标签/自言自语改动（我们 vs 上游搬包前差 7+/82- 行）。
  建议**只手工套结构部分**：新增 `_append_context_blocks` / `_append_incomplete_source_guard` /
  `_plain_text_answer_instruction`，两个 single builder 按新顺序重排，不搬无关的提示词文案改动。
- 改完必须重录冻结提示词基线（[test_prompt_input_snapshot.py](../../../backend/pipeline/devtools/tests/translation/test_prompt_input_snapshot.py) 的 `_DIGESTS`），
  逐例审阅后再写新哈希；否则门禁红。
- 和我们记过的 hy-mt2 截断问题相关（提示词排法与模型自说自话），值得优先。

**落地说明**：`f6e30a2` + `566af39` + `3925a8e` + `cf72687` 已落；测试文件按上游原样搬
（`test_self_correction_leak.py`、`test_math_brace_balance.py`），`test_translation_prompt_protocols.py`
补了「前后文在前、作答要求最后一行」用例，三个旧断言改成新格式。冻结基线第三次重录：

- `placeholder` route 0（逐段 fallback）变了；route 1（批量 JSON）与 route 2（group member）一字未动
- `direct_typst` route 0/1 变了，route 2 未动
- 说明改动只落在两个逐段 builder，没有改宽

文档：[translation.md](../../core/python/translation.md) 新增「逐段请求的提示词排法」一节。

测试：各提交自带的 devtools 测试直接复制；`cf72687` 的断言已写在新格式上，照抄即可。

估算：2–3 天（M），其中 `cf72687` 占一半。

---

## 不建议回移（本轮）

- jobsd 未配 key 时默认拒绝（`38280a3` 的一半）：与匿名模式冲突，见 P0-2。
- 网站账号 / 多用户 / 页数额度 / 管理后台（10-10～10-22 一大片）：与插件单用户定位无关。
- 路由统一改名（`/jobs/:id/pdf` → `/files/output/*`、`/progress-events` → `/progress/stream`）：
  会同时破坏插件与两页网页，属于整仓同步范畴，不在本清单。
- 任务状态一致性那一批（运行代次 / CAS / 取消 / 续跑）：收益最大但耦合最深，单独排期。

## 建议执行顺序

1. ~~P0-3 → P0-1 → P0-2~~（2026-10-28 完成，先落安全网）
2. ~~P1-5 + P1-4~~（2026-10-28 完成）
3. ~~P1-6a~~（2026-10-28 完成）
4. ~~P1-8（`f6e30a2` + `3925a8e` + `566af39` + `cf72687`；`004db26` 不适用）~~（2026-10-28 完成）
5. ~~P1-7~~（2026-10-28 完成）

## 验证

- Rust：`cargo test -p rust_api -p retain-jobsd -p retain-core -p retain-db`（按改动范围取子集）
- 架构门禁：`python3 backend/api/scripts/check_architecture.py`、`python3 backend/pipeline/devtools/check_pipeline_architecture.py`
- 翻译/流水线：`backend/.venv/bin/python -m pytest backend/pipeline/devtools/tests/translation`
- 全量本地门禁：`.github/scripts/tests/`（推送前按 [本地门禁清单]）

### 2026-10-28 本轮实测

- `cargo test -p rust_api`：542 passed / 0 failed / 3 ignored（含 500 脱敏、参数上限、
  请求编号/查询串、磁盘门禁、派生缓存回收的新用例）
- `cargo test -p retain-core`、`retain-data`、`retain-jobs`：全部通过；`retain-db` 83 passed；
  `retain-jobsd` 7 passed
- `python3 backend/api/scripts/check_architecture.py`、`check_pipeline_architecture.py`：passed
- `pytest backend/pipeline/devtools/tests/translation`：1219 passed
- `pytest backend/pipeline/devtools/tests`：2393 passed / 15 skipped，唯一失败是
  `test_package_versions.py::test_workspace_version_matches_release_tag`——HEAD 恰好是插件 tag
  `v0.1.12` 而 Python workspace 是 `4.2.6`，属于快照形态的既有现象，与本次改动无关
- `.github/scripts/tests`：144 passed，仅剩存量红 `dirty_check` fonts 用例（backend-package.json 缺 aggregates）
- `cargo fmt --check`：改动文件无 diff；仓库里剩余的是既有 rustfmt 版本噪音

