# Zotero 插件施工图（路线 A）

> 状态：规划中 · 2026-10-11 立项
> 决策依据：[ADR 0007](../../../adr/0007-own-zotero-plugin.md)。UX 与产物语义参考
> [路线 B 文档 §3](./zotero-pdf2zh-protocol-emulation.md)（上游行为逆向成果）。
> API 契约以 [docs/api/](../../../api/README.md) 为准，本文不另立字段定义。

## 1. 产品流程

右键 Zotero 条目/附件 → 上传 PDF 到 retain-pdf → 服务端 OCR/翻译/渲染 →
进度实时可见 → 产物（纯译文 + 双语对照）自动挂回条目子附件。

## 2. 仓库与底座

- 单仓库 `plugin/` 子目录（ADR 0008 修订；对标 zotero-pdf2zh 单仓发布）
- zotero-plugin-template（TypeScript + esbuild → .xpi），目标 Zotero 7+：manifest 写 `strict_min_version: 6.999` + `strict_max_version: "*"`（Zotero 10 实测：上限不写被当未适配拒装，写死 `8.*` 在 10 拒装；`"*"` 为 Zotero 官方测试插件的写法）
- 许可证 MIT；**clean-room**：上游 zotero-pdf2zh 源码只读行为、不抄代码
- 插件配置（prefs）：服务端 Base URL、访问密钥（可选，服务端上锁时才填）、
  PaddleOCR Token、LLM（model / base_url / api_key）、并发数 workers——
  全部随任务携带（ADR 0009）

## 3. API 映射（retain-pdf 原生契约）

| 插件动作 | 端点 | 备注 |
|---|---|---|
| 检查连接 | `GET /health` | 无鉴权 |
| 提交翻译 | `POST /api/v1/jobs` | multipart 上传 + translation 参数 |
| 任务进度 | `GET /api/v1/jobs/{job_id}` | 只读 `display_stage` / `substage` / `lane=main`，纪律照 api README「前端读取原则」 |
| 实时事件 | `GET /api/v1/jobs/{job_id}/live-events`（SSE） | M2 接入；断线以详情轮询兜底 |
| 取消 | `POST /api/v1/jobs/{job_id}/cancel` | |
| 产物清单 | `GET /api/v1/jobs/{job_id}/artifacts-manifest` | 产物 key 语义 M0 核对 |
| 下载产物 | `GET /api/v1/jobs/{job_id}/pdf`、`/pdf/side-by-side`、`/download` | 与 mono/dual 的命名映射 M0 确认 |
| 失败重试 | `POST /api/v1/jobs/{job_id}/retry-stage` | |

鉴权：可选（ADR 0009）。服务端配置了 `RUST_API_KEYS` 时除 `/health` 外统一
`X-API-Key` 请求头；开放模式下不带。

## 4. UX 参考（上游行为，来自路线 B §3）

- 产物双文件惯例 `-mono` / `-dual`，按文件区分挂载行为
- 远程模式"翻译完成后优先通过 HTTP 挂附件"，不依赖服务端绝对路径
- 进度以任务为单位展示（上游为 SSE 每秒 tasks 快照；我们改用详情 + SSE）
- 批量翻译多选条目；重复提交同一附件不产生重复任务

## 5. 里程碑

| 里程碑 | 内容 | 验收 | 预估 |
|---|---|---|---|
| M0 脚手架 | ✅ 完成（2026-10-12）：右键菜单 + 附件识别 + 偏好三项 + `/health` 检查连接；待真机 Zotero 验收 | dev Zotero 中菜单可见、连接检查通过 | 已用 0.5 天 |
| M1 单文件 MVP | ✅ 代码落地（2026-10-12）：上传（携带 prefs 凭据/模型/并发）→ 轮询（display_stage/substage 文案）→ 下载 mono+dual → `importFromFile` 挂回；上传/建任务契约经 40001 实例 curl 验证；待真机 Zotero 验收 | 单本书从右键到挂回全程跑通 | 已用 0.5 天 |
| M2 体验对齐 | ✅ 代码落地（2026-10-12）：进度事件轮询（`/events` 2s 刷 stage_detail 人话 + percent 进度条，详情 10s 定终态，seq 去重、lane=main 优先）、mono/dual 双挂载（M1 已带）、失败双行展示（failure.root_cause + suggestion，失败不自动关窗）。**勘误**：`/live-events` 是译文预览 SSE 流而非进度流，进度走 `/events` 轮询。retry-stage 契约已读（返回新 job_id 直接轮询），因 ProgressWindow 无按钮载体，交互入口与取消一起放 M3；待真机验收 | 进度实时刷新；断线重连后状态从详情恢复 | 已用 0.5 天 |
| M3 批量与配置 | 多选批量、产物偏好（mono/dual）、术语表透传（参数前置已随 M1 落地） | 批量 3 个条目全部挂回；参数生效 | 1–2 天 |
| M4 分发与部署形态 | xpi + GitHub Release + updates.json；远程方案三选一 | 新机器按 README 装插件即可用 | 待定 |

## 6. 部署双形态

### 本地（v1 默认）

- compose 或 dev_stack 起栈（AI 摘除后仅 rust_api + jobsd + pipeline）
- 插件配 `http://127.0.0.1:41000` 或本机 nginx 入口

### 远程（M4 决策，三选一）

| 方案 | 做法 | 评价 |
|---|---|---|
| ① VPN / 内网直连 nginx（:40002） | 不过 Cloudflare，直连源站 | v1 默认；零改造，但要求网络可达 |
| ② Cloudflare Access Service Token | 公网域名，边缘放行带 Service Token header 的请求 | 自有插件可发自定义 header（上游插件做不到的点）；推荐候选 |
| ③ 独立 API 子域不开 Access | 只靠 X-API-Key + 限流 | 攻击面大，仅作保底 |

背景约束：当前公网入口的 Cloudflare Access（OTP）挡机器客户端，插件无法完成浏览器 OTP 流程。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| Zotero 大版本 API 变动 | 锁 Zotero 7；manifest 声明兼容范围 |
| 大 PDF 上传超时 / 体积上限 | 服务端 body 上限核对；插件侧超时与提示 |
| SSE 过公网网关空闲超时 | M2 详情轮询兜底；事件心跳 |
| 术语表等参数 UI 复杂度 | M3 才做，M1 仅默认参数 |
| clean-room 纪律滑坡 | 插件仓库贡献文档写明红线；review 对照上游 diff |

## 8. 许可证注记

插件纯自有代码 → MIT。服务端维持"私有部署不分发"结论，AGPL 不触发。
若未来插件或服务端转公开分发，回到商业化许可证审计的三条路。
