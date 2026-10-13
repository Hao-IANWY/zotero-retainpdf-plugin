# Zotero 集成：pdf2zh server 协议模拟（路线 B）

> 状态：**已取代**（2026-10-11 同日）——决策变更为自研插件（路线 A），
> 见 [ADR 0007](../../adr/0007-own-zotero-plugin.md)。
> §3 的协议契约逆向成果保留，作为自有插件的 UX/产物语义参考；
> §4–§7 的服务端改造计划不再执行。
> 原决策（已作废）：不开发自有 Zotero 插件，由 retain-pdf 后端实现
> pdf2zh server 的 HTTP 协议，直接复用
> [guaguastandup/zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh) 插件。

## 1. 背景与目标

Zotero 是文献管理主场景：用户在库中管理 PDF，期望"右键附件 → 整篇保留排版翻译 → 双语 PDF 自动挂回条目"。

生态里 zotero-pdf2zh 插件已经实现了这条链路的全部 UI（右键菜单、进度条、产物挂附件、批量、裁剪阅读），其架构是"**插件 + HTTP server**"两件套，默认与本机 `127.0.0.1:8890` 的 Python server（pdf2zh / pdf2zh_next 引擎）通信，v4.1.7 起支持远程 server。

RetainPDF 本身就是排版保留翻译引擎，API 链完整（上传 → 任务 → 产物）。**模拟 pdf2zh server 协议 = 插件把 RetainPDF 当成引擎，完全无感切换后端。**

目标：装上游插件，server IP 指向 retain-pdf 的兼容层，全流程可用。

## 2. 决策记录

| | 路线 A：自研插件（scaffold 新仓库） | 路线 B：协议模拟（**当时已选，现已被 ADR 0007 取代**） |
| --- | --- | --- |
| 改造位置 | 全新 TS 插件 + 适配 API | 仅服务端一层 adapter 路由模块 |
| 分发义务 | 插件若含上游 AGPL 代码需开源 | 不分发任何插件/上游代码 |
| 维护面 | 插件 UI + 版本兼容 + 更新机制 | 跟随上游插件的协议演进 |
| 协议形态 | 自定契约，自由 | 逆向契约，无正式 spec |

- 退出策略：若上游插件协议大改且无法跟进，adapter 中固化的契约知识（见 §3）可直接迁移为路线 A 的 API 设计输入。（2026-10-11 注：此退出策略已触发，直接转路线 A。）
- 仓库策略配套决策（同日）：GitHub 上原 wxyhgk/retain-pdf 的 fork 已删除，本地仓库转为独立私有仓库 `Hao-IANWY/retain-pdf`，README 增加上游致谢。

## 3. 协议契约（逆向自 zotero-pdf2zh `server/server.py`，对齐 v4.1.7）

### 3.1 端点总览

| 路径 | 方法 | 功能 | 优先级 |
| --- | --- | --- | --- |
| `/health` | GET | 健康检查 / 插件"检查连接"探测点 | P0 |
| `/translate` | POST | 翻译任务提交 | P0 |
| `/events` | GET | SSE 进度推送（每秒一帧） | P0 |
| `/api/tasks` | GET | 活动任务列表（轮询兜底） | P0 |
| `/translatedFile/<filename>` | GET/HEAD | 产物下载（`?preview=true` 内联） | P0 |
| `/compare` | POST | 双语对照翻译 | P1 |
| `/crop-compare` | POST | 裁剪 + 对照 | P2 |
| `/crop` | POST | 裁剪 | P2 |
| `/translatedInfo` | GET | 列出产物目录（`?stem=` 过滤） | P1 |
| `/api/history` | GET | 翻译历史 | P2 |
| `/api/config` | GET | 服务配置信息 | P2 |
| `/` | GET | 进度监控页 index.html | 可不实现 |

### 3.2 任务提交（JSON + Base64，非 multipart）

`/translate` 等四个操作端点统一走 `process_request()`：

- 请求体为 JSON：`fileName`（纯文件名、必须 `.pdf` 结尾，服务端做路径穿越校验）、`fileContent`（Base64，可带 `data:application/pdf;base64,` 前缀）
- 其余字段封装为 `Config`：`engine`（pdf2zh / pdf2zh_next）、`sourceLang`、`targetLang`、`service`、`asyncJob` 等
- **注意 Base64 膨胀约 33%**，大文件场景需放宽兼容层的请求体上限

### 3.3 同步 / 异步双协议

`_client_wants_async_job()` 判定：请求头 `X-PDF2zh-Protocol: accepted|async`，或 body `asyncJob=true` / `clientProtocol` 同值：

- **异步**：`200 {'status': 'accepted', 'taskId': <uuid4>}` 立即返回，后续凭 taskId 查询/取件
- **同步**：阻塞到完成，返回 `{'status': 'success', 'fileList': [...], 'filePaths': [...], 'outputDir': ...}`
- 注释明确：旧插件会把 `accepted` 当失败 → 兼容层两种模式都必须实现

### 3.4 进度与产物

- `/events`：SSE，服务端每秒 `data: <tasks JSON>\n\n` 一帧；`/api/tasks` 提供同样的数据供轮询
- 产物落盘 `translated/` 目录；`/translatedFile/<filename>` 下载时做 `basename` + `commonpath` 防穿越，不存在 404
- 远程模式下插件"翻译完成后优先通过 HTTP 挂载附件"（即走 `/translatedFile` 取文件，不依赖 `filePaths` 绝对路径）

### 3.5 健康检查与错误语义

- `/health` 固定 200：`{'status': 'ok', 'version': ..., 'message': 'PDF2zh Server is running', 'outputDir': ...}` —— 形状必须原样复刻
- 错误码：400（非法 JSON / 文件名 / 路径 / 操作类型）、404（产物不存在）、409（对已是 compare 产物重复操作）、500（未分类）
- 错误 payload 统一：`{'status': 'error', 'ok': False, 'message': ...}`，可附 `errorType`、`exitCode`

## 4. retain-pdf 侧改造点

> （已不执行，保留原文）

1. **挂载位置**：独立路由模块（pdf2zh-compat），监听独立端口或独立路径前缀，**不侵入现有 API**；与现有 API 链的关系是"同一任务管线的另一种 HTTP 投影"
2. **任务模型映射**：retain-pdf 现有异步 job → pdf2zh 的 `taskId` + SSE tasks 快照；需把内部进度状态投影为插件实际解析的 tasks JSON 字段（字段名待 M0 抓包确认，见 §5）
3. **产物语义**：pdf2zh 惯例产物为 `xxx-mono.pdf` / `xxx-dual.pdf` 双文件，插件按后缀区分挂载行为 → 兼容层输出命名需对齐（待 M0 确认确切后缀约定）
4. **四操作映射**：
   - `/translate`（纯译文）、`/compare`（双语对照）→ RetainPDF 天然支持
   - `/crop` / `/crop-compare`（裁剪阅读）→ 无对应能力，规划为显式 400 + 明确 message 的**降级不支持**（插件端会展示错误，可接受）
5. **参数映射**：`sourceLang` / `targetLang` / `service` → retain-pdf 翻译配置；`engine` 忽略（仅日志）；**未知字段一律宽松忽略**，保证对未来插件版本的前向容忍
6. **鉴权与网络**：
   - 本地模式（`127.0.0.1:8890` 指向本机兼容层）：pdf2zh server 本就无鉴权，保持一致即可
   - 远程模式：**与 Cloudflare Access（OTP）天然互斥**——插件端只能配 IP，大概率不支持自定义鉴权 header（待确认）。现实方案限定内网 / VPN 直连；公网开放需另行评估（见 §5）

## 5. 开放问题（M0 待解决）

> （已不执行，保留原文；其中 §3 相关问题的答案对自有插件的 UX 设计仍有参考价值）

- [ ] 插件实际发送的完整字段集（读插件 src 的 API client + 本地起官方 server 抓包对照）
- [ ] SSE `/events` 每任务对象的确切 schema（status / progress / fileName …）
- [ ] 产物双文件的后缀约定（`-mono` / `-dual`?）与 `fileList` 语义
- [ ] 插件端是否支持自定义鉴权 header（决定远程部署形态）
- [ ] `HEAD /translatedFile` 是否被插件用于预检
- [ ] 版本锁定：以 v4.1.7+ 的 async 协议为基准，是否显式拒绝旧协议客户端

## 6. 风险

> （已不执行，保留原文）

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 契约是逆向的，无 spec | 上游小改即断 | 契约文档化（本文 §3）+ M0 抓包固化回归用例 |
| tasks JSON 字段不匹配 | 进度条静默失败 | M0 以真实流量为准，不靠猜 |
| crop 能力缺失 | 部分菜单项报错 | 显式 400 + 明确文案，文档声明 |
| 大 PDF Base64 上传 | 请求体超限 | 放宽兼容层 body 上限 |
| 协议演进不可控 | 长期维护成本 | 退出策略：迁移路线 A，契约知识复用 |

## 7. 里程碑与验收

> （已不执行，保留原文）

| 里程碑 | 内容 | 预估 |
| --- | --- | --- |
| M0 契约固化 | 装上游插件 + 官方 server，抓包记录 `/translate` `/events` `/translatedFile` 真实流量；读插件 src；补齐 §5 全部问题 | 1 天 |
| M1 本地 MVP | `/health` + `/translate` 同步模式跑通单 PDF，产物可下载 | 2–3 天 |
| M2 异步全流程 | taskId + SSE + `/api/tasks`，双语产物自动挂回 Zotero 附件 | 2 天 |
| M3 语义对齐 | `/compare`；`/translatedInfo` `/api/history` `/api/config`；crop 显式降级 | 1–2 天 |
| M4 远程形态 | 内网 / VPN 方案 + 安全评估（视需求） | 待定 |

**M2 验收标准**：插件设置 Python Server IP 为兼容层地址 → "检查连接"通过；右键附件翻译 → 进度实时刷新 → 双语 PDF 自动挂回条目；重复提交同一附件不产生重复任务。

## 8. 许可证影响

- 路线 B **不分发**任何上游代码与插件：用户自行安装 AGPL-3.0 的上游插件，调用我们的服务端；实现协议本身不构成衍生作品
- 服务端维持既有审计结论（自有代码 MIT + PyMuPDF AGPL 运行时依赖）：**私有部署、不分发 → 无 AGPL 开源义务触发点**
- 若未来转公开托管服务，回到许可证审计的三条路（买 Artifex 授权 / 换库 / 开源）
