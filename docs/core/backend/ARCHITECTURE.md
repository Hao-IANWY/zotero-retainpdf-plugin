# RetainPDF 后端架构

> 当前快照：2026-10-11。本文描述现行 `backend/` 后端；历史进程拆分决策见
> [ADR-0005](../../adr/0005-shell-and-backends.md)，AI 问答链路的移除见
> [ADR-0006](../../adr/0006-remove-ai-chat.md)。

## 部署边界

RetainPDF 面向本地与自托管 Docker，不按云端微服务拆库。代码以清晰的
包、crate、进程和协议边界解耦，持久状态仍由同一后端数据根统一管理。

```text
Zotero 插件 / frontend/web
  └─ rust_api
       ├─ :41000  完整 HTTP API、下载、SSE、健康与就绪检查
       ├─ :42000  仅 POST /api/v1/translate/bundle
       └─ retain-jobsd :41002（remote 模式、仅回环、可选监督）
            └─ Python pipeline workers
```

Rust 的原始配置默认使用进程内 jobs runtime，并关闭子服务监督。仓库的权威
开发入口 `python3 ops/development/dev_stack.py` 会显式选择
`remote + supervised`，由 `rust_api` 监督 jobsd。当前 Docker 镜像保持
jobs runtime 默认进程内模式，除非部署者明确开启 remote。

| 启动形态 | jobs runtime | 说明 |
| --- | --- | --- |
| 直接运行 `rust_api` | 默认 in-process，不监督 | 由环境变量显式改变 |
| `ops/development/dev_stack.py` | remote，Rust 监督 jobsd | 当前权威开发入口 |
| 打包 Electron | remote，Rust 监督 jobsd | desktop main 为 packaged 模式注入配置 |
| `ops/deployment/docker/backend/Dockerfile.app` | 默认 in-process | jobsd 二进制已打包，但默认不启动 |

`/health` 始终提供诊断视图；`/ready` 只把数据库和当前配置为“受监督”的子服务
列为必需组件。41002 必须保持回环地址。任何非回环 API 部署都必须显式
配置强随机 `RUST_API_KEYS`，不能使用开发启动器的默认 key。

## 目录与职责

| 目录 | 职责 |
| --- | --- |
| `backend/api/` | Rust HTTP 壳、持久化、任务编排、恢复、下载与安全边界 |
| `backend/packages/retain-core/` | 配置、公共模型、路径和失败契约 |
| `backend/packages/retain-data/` | SQLite、OCR provider、worker command 与持久化适配 |
| `backend/packages/retain-jobs/` | worker 生命周期和 pipeline 执行状态机 |
| `backend/jobs/` | 可选的独立 jobs runtime 进程 |
| `backend/packages/retain-proc/` | 进程组与 OS 进程工具 |
| `backend/pipeline/` | OCR 归一化、翻译、修复、渲染与 PDF 处理 |
| `backend/config/` | Rust/Python 共享 provider 配置 |
| `backend/contracts/` | 独立后端包使用的 schema 镜像 |

主 crate 通过兼容 façade 暴露下层 crate，业务代码保持单向依赖。架构门禁位于
`backend/api/scripts/check_architecture.py` 和
`backend/pipeline/devtools/check_pipeline_architecture.py`。

## 状态所有权

API 内部继续保持模块化单体：读模型 `JobQueries` 仅依赖数据库与数据根，
命令仍由 `JobsFacade` 承担；`JobDownloads` 独立持有下载与派生产物所需能力。
同步读工作经 `QueryExecution` 有界阻塞池，下载生成使用独立调度器。这里只
收窄进程内依赖，不新增微服务或消息代理。

普通／OCR 事件查询使用 SQLite 可重建投影、来源检查点与 cursor v2；其
delivery seq 不等于原始事件 seq，也不等于翻译 SSE seq。协议、保留策略及
协同发布要求见 [事件 v2](../api/event-feed-v2.md)。

- Rust 后端是 document、credential、job、pipeline attempt/unit 与 commit
  状态的权威来源。
- remote 模式下 API 壳与 jobsd 通过同一 `retain-data` 数据层访问 SQLite；
  浏览器不能直接写数据库。
- pipeline worker 生产 artifact 与 checkpoint 文件并发射受约束事件；Rust
  保存生命周期、attempt、generation、unit 和事件投影。
- SSE 和类似通知都是刷新提示。断线重连后，消费者必须重新读取 Rust 的
  任务或 committed translation 快照。
- 页面翻译只在 checkpoint 文件 hash 与 durable committed unit 一致时可见；
  worker 内存、尚未提交文件和模型 token 流都不是可恢复状态。

### 数据根布局

`RUST_API_DATA_ROOT` 是运行数据的共同根。开发启动器默认使用仓库根 `data/`，
Docker 使用 `/data`；`services/data/` 不是通用运行真值。

| 路径 | 所有者与语义 |
| --- | --- |
| `db/jobs.db` | Rust/retain-data 的 SQLite 权威状态；remote jobsd 通过 WAL 访问同一库 |
| `jobs/<job_id>/` | stage spec、provider 快照、checkpoint 与发布产物 |
| `uploads/`、`downloads/` | 受管理的输入和派生下载 |
| `secrets/credentials.json` | Rust 管理的凭据 vault；位于 SQLite 外，要求受限权限且不回显明文 |

恢复需要数据库状态和匹配的 job/checkpoint 文件，因此备份或迁移必须覆盖整个数据根，
不能只复制 `jobs.db`。

这套边界允许 API 壳重启而不终止 remote jobsd 中的 worker，也允许服务重启后
从 durable attempt/unit 与匹配的 translation checkpoint 恢复。未提交的模型
输出不会被伪装成已完成状态；远程 provider 请求处于不确定状态时仍需显式解决
歧义，不能自动重复提交。

## 协议真值

| 边界 | 协议真值 | 关键门禁 |
| --- | --- | --- |
| Web/desktop ↔ Rust API | `backend/api/API_SPEC.md` 及 `backend/api/docs/api-spec/` | Rust API contract tests、前端 API tests |
| monorepo wire DTO | `contracts/*.schema.json` | `npm --prefix contracts test` |
| 独立后端 schema 镜像 | `backend/contracts/*.schema.json` | `python3 backend/contracts/check_parity.py --require-upstream` |
| Rust ↔ jobsd | `jobs-control.v1.schema.json` | shell/jobsd 双端 contract lock |
| Rust ↔ pipeline stdout | `pipeline-stdout.v1.schema.json` | retain-jobs 与 pipeline 双端 contract tests |
| Rust ↔ pipeline stage input | versioned stage spec 与对应 Rust/Python模型 | stage-spec checks 与 worker tests |
| Paddle raw ↔ `document.v1` | [PaddleOCR 官方布局标签与归一化基线](../paddle_ocr_api/layout-labels.md) | adapter 映射、归一化报告与全量标签契约测试 |
| MinerU raw ↔ `document.v1` | [MinerU 官方输出类型与归一化基线](../../reference/mineru_api/output-types.md) | block/span 目录、层级去重、bbox 与 adapter 契约测试 |

修改 schema 时先更新 `contracts`，同步 `backend/contracts` 镜像，再让
生产者、消费者和 parity 门禁全部通过。API 细节不能只靠 schema 推断；路径、
认证、错误、恢复和下载行为以 Rust API spec 与实现契约测试为准。

## 当前验证命令

从仓库根目录运行：

```bash
python3 backend/api/scripts/check_architecture.py
uv run --project backend --locked --all-extras cargo test --locked --workspace
PYTHONPATH=backend/pipeline uv run --project backend python backend/pipeline/devtools/check_pipeline_architecture.py
uv run --project backend python -m pytest backend/pipeline/devtools/tests -q
python3 backend/contracts/check_parity.py --require-upstream
npm --prefix contracts test
```

固定测试数量不是契约，文档只记录应执行的 suite。需要真实 provider 凭据的
live OCR/翻译验证必须单独报告，不能用离线单测通过替代。
