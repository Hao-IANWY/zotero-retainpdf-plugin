# Zotero 插件原生中控台：嵌入路线探索报告与页面方案

> 状态：2026-10-14 立项。嵌入现网监控台 HTML 的路线（v0.1.7–v0.1.10，五轮迭代）
> 探索收口——已点亮但天花板太低；转向插件原生页面（自带 XHTML + API 数据），
> 风格学习网页监控台设计系统，同步沉淀插件 UI 资产层。
> 进度（2026-10-14）：N0–N2 代码全部落地并通过构建/lint——UI 资产层
> （`addon/content/ui/tokens.css` + 12 枚图标 + `dashboard/dashboard.{xhtml,css}`）、
> 数据链路（`listJobs`/`deleteJob` 入 `RetainPdfClient`，3s 轮询 + SSE）、
> 窗口壳（`dashboardWindow.ts` 接替 monitorWindow.ts，iframe 实现已删除）。
> 待老板机真机验收：开窗观感（明暗两主题）、进度刷新、清空分组、详情外链。
> 接替：[Zotero 插件内嵌监控台窗口](./zotero-monitor-window.md)（嵌入路线定格为过程档案）。
> 前置：[Zotero 插件施工图](./completed/zotero-plugin-development.md)、
> [20261014 插件体检与修复计划](../problems/20261014_zotero插件体检与修复计划.md)。

## 1. 一句话结论

内嵌浏览器元素载现网监控台 HTML 这条路，Gecko 层的坑已全部排完、窗口能点亮，
但「能亮」就是它的上限——鉴权、联动、错误态、观感都是结构性无解；
改做**插件原生中控台页面**：窗口壳与入口沿用已验收资产，内容换成插件自带的
XHTML 页面，数据走 `RetainPdfClient`，视觉契约照抄网页监控台的 token 体系。

## 2. 嵌入路线探索历程（v0.1.7 → v0.1.10）

目标始终不变：Zotero 内盯任务进度，不开浏览器。嵌入路线的设想是「窗口内嵌浏览器
元素直接加载监控台现网 HTML，插件零实现 UI，监控台改版零跟进」。五轮迭代：

| 版本 | commit | 尝试 | 结果 |
|---|---|---|---|
| v0.1.7 | fbbd95e | `ztoolkit.Dialog` 非模态大窗 + XUL `<browser>` 载 `{root}/index.html`；工具栏/右键双入口；几何记忆、单例聚焦 | 真机白屏：browser 缺 `type="content"`，chrome 权限拒载远程 URL |
| v0.1.8 | 86354fd 等 | 体检修订：browser 补 `type="content"`；删右键菜单与 `monitorUrl` pref；工具栏按钮注入 `#zotero-toolbar` | 按钮根本没出现——Zotero 7 **不存在** `#zotero-toolbar`（拉源码证实），注入静默跳过 |
| v0.1.8 补丁 | 1ff9b4a / 8ffbbee | 注入点改 `#zotero-items-toolbar` 搜索框右侧（逐层回退）；图标 `image` 属性 + `list-style-image` 双保险；开窗全链路落日志 | 按钮到位；窗口仍白屏 |
| v0.1.9 | cde449a | 白屏根因二连修：about:blank 文档 `html/body` 无高度 → flex 链塌缩归零（改 `100vw/100vh` + 注入 `height:100%`）；content 文档 load 不冒泡 → capture 监听 | browser 的 load 事件仍无记录，白屏依旧 |
| v0.1.10 | 69b9ccd | 载体弃 XUL browser 换 HTML `<iframe>`——frame loader 创建时机在 HTML 文档里不可靠，iframe 是原生元素零玄学 | **点亮**。直连形态下窗口可用 |

周边建设（这些与载体无关、全部保留）：开窗前探测 `GET {root}/index.html` 拦截错址；
探测失败通知带内网代理提示；Gecko console 缓冲抓取进插件日志；iframe load 15s
看门狗；窗口几何 pref 持久化。

### 点亮之后：四条结构性问题

v0.1.10 已可用，但以下问题不是 bug，是「嵌现网 HTML」这条路线的属性，修不掉：

1. **鉴权死局**。iframe 导航注入不了自定义请求头——Cloudflare Access 公网形态
   天然不可用；将来服务端 `RUST_API_KEYS` 上锁，窗口同样过不去。中控台被锁死在
   「匿名 + 直连」部署形态上。
2. **与插件零联动**。iframe 内页面碰不到插件 API：不能定位 Zotero 条目、不能
   下载挂回、翻译完成不能从窗口跳到详情。想联动就得往网页端塞桥接代码——
   「插件零跟进」的收益反过来咬人：每一点联动都要两边一起改、一起发版。
3. **信息架构不匹配**。网页监控台是通用任务中心（全量任务、加载更多、分组清空），
   插件场景八成是「我刚提交的翻译任务怎么样了」。嵌入把整个 SPA 的复杂度搬进来，
   却没有裁掉任何一角。详情页 `target=_blank` 在 iframe 里无默认行为只是表征。
4. **故障面不可控且观感不原生**。三连 Gecko 玄学（chrome 权限拒载 → 高度链塌缩 →
   frame loader 时机）耗了四个版本才点亮；运行中断网靠 neterror 页兜底；
   每次 Zotero 大版本升级，这套载体都要重新真机验证。React SPA 的字体密度在
   桌面窗口里也始终是「网页感」。

当初否决「页面打进插件」的三条理由（CORS、鉴权、改版跟随），此时逐条复核：
CORS——原生页数据走 `Zotero.HTTP.request`，chrome 权限下无 CORS 概念，理由消失；
鉴权——API 客户端可带自定义头，比 iframe 更能适应将来上锁，理由反转；
改版跟随——原生页不追网页改版是真代价，但由「UI 资产与网页端同 token 契约」
缓解（§5），且插件视角本就只需要任务中心的一个切片。

**结论：嵌入路线定格，v0.1.10 的 iframe 实现保留到原生页验收后退役。**

## 3. 新方案：插件原生中控台页面

### 3.1 形态

- **窗口**：弃 Dialog+iframe 外壳，改 `window.openDialog` 直接开
  `chrome://retainpdf/content/dashboard/dashboard.xhtml`——与 preferences.xhtml
  同一管线（chrome 页 + `onload` 派发到 hooks → TS 模块），Zotero 插件主窗口的
  标准形态。少一层文档 = 少一类高度链/焦点/主题传递玄学，iframe 已无存在必要
  （不载远程页了）。
- **保留资产**（monitorWindow.ts 中已验收的部分）：搜索栏右侧工具栏入口按钮、
  单例聚焦、几何记忆 pref。
- **退役**：iframe 载体、neterror 兜底依赖、开窗前 `/index.html` 探测——原生页
  本地加载零网络依赖，开窗不再探测；服务不可达由页面内错误态呈现（错误态是
  UI 的一部分，不再是裸白屏，这本身就是嵌入路线做不到的）。

### 3.2 数据链路

| 能力 | 端点 | 插件侧现状 |
|---|---|---|
| 任务列表 | `GET /api/v1/jobs?limit&offset`（契约 `JobListItemView`） | `RetainPdfClient` 需补 `listJobs` |
| 行级实时进度 | `GET /api/v1/jobs/{id}/progress-events`（SSE） | `watchProgressEvents` 已有，直接复用 |
| 进度兜底轮询 | `GET /api/v1/jobs` 周期重拉（3s，对齐网页端） | 随 `listJobs` 落地 |
| 清空历史分组 | `DELETE /api/v1/library/books/{job_id}`（`-ocr` 行跳过，同网页端纪律） | 需补 `deleteJob` |
| 任务详情 | `detail_url` 外链浏览器（v1）；原生详情页后续再议 | `Zotero.launchInBrowser` |

消费纪律不变：主状态只读 `status`，进度只读 `stage_snapshot.progress`，文案字段
只做展示。活跃任务 SSE 优先、轮询兜底，与网页端 `useTaskLiveProgress` 同策略；
窗口 unload 统一关流，代际号防回写（网页端 `mountedRef`/`generationRef` 同款）。

### 3.3 范围裁剪（只做插件视角）

- 分组：运行中 / 排队中 / 失败 / 已完成（四组，顺序与标签同网页端）。
- 计数条：全部 / 运行中 / 排队中 / 失败 / 已完成五格。
- 任务卡片：文档图标、名称、job_id 截断、流程标签、相对时间（分钟粒度，
  避免心跳重渲染抖动）、活跃任务进度条、状态 pill、「打开详情」（外链）。
- 清空：仅失败/已完成组（真删后端记录，运行中后端 409 兜底）。
- **不做**：取消/重试等运行干预（与网页任务中心同纪律——干预走翻译动作或
  API）；全量分页加载更多（插件视角取最近一页 50 条足够）；多皮肤切换
  （明暗跟随系统即可）。

## 4. 视觉：学习网页监控台的设计系统

网页监控台（[frontend/web](../../../frontend/web/)）的视觉资产值得移植的不是
React 组件，而是它的**设计契约**（[themes/_contract.css](../../../frontend/web/src/styles/themes/_contract.css)）：

- 语义 token：`--bg --paper --surface --ink --muted --line --accent(-weak)
  --danger(-weak) --ok(-weak) --warn(-weak) --gold(-weak) --shadow-color`，
  组件只消费语义名，换肤不改组件。
- 默认皮 classic（Apple 式克制黑白灰）+ night（黛瓦夜色），恰好对应桌面窗
  明暗两态；mojia/jiangnan/seacliff 等文化皮不移植。
- 版式骨架：头部（ eyebrow 小标题 + 大标题 + 刷新按钮）→ 五格计数条 →
  双列分组网格 → 任务卡片（图标 + 徽章 + 标题 + 元信息 + 进度条 + pill +
  操作行）。
- 图标语义：lucide 选型（Activity=运行、Clock3=排队、TriangleAlert=失败、
  CheckCircle2=完成、RefreshCw=刷新、Eraser=清空、FileText=文档、
  LoaderCircle=加载）。

```
┌──────────────────────────────────────────────────────────┐
│ 中控台                            ⟳ 刷新                  │
│ PDF 处理任务                                              │
│ 当前加载 N 条；每次处理按独立任务展示                      │
│ ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐                 │
│ │  12  ││  2   ││  1   ││  1   ││  8   │  ← 计数条      │
│ │ 全部 ││运行中││排队中││ 失败 ││已完成│                 │
│ └──────┘└──────┘└──────┘└──────┘└──────┘                 │
│ ┌─ ⚡ 运行中 ──────────┐  ┌─ 🕐 排队中 ──────────┐       │
│ │ ┌──────────────────┐ │  │ ┌──────────────────┐ │       │
│ │ │▣ 论文标题          │ │  │ │▣ 论文标题          │ │       │
│ │ │ 任务 abcd…wxyz ·   │ │  │ │ 任务 … · 5 分钟前  │ │       │
│ │ │ 翻译 · 3 分钟前     │ │  │ │                  │ │       │
│ │ │ ▓▓▓▓▓▓░░░░  62%   │ │  │ │                  │ │       │
│ │ │         [打开详情] │ │  │ │         [打开详情] │ │       │
│ │ └──────────────────┘ │  │ └──────────────────┘ │       │
│ └──────────────────────┘  └──────────────────────┘       │
│ ┌─ ⚠ 失败 ─────────────┐  ┌─ ✓ 已完成 ──── [清空] ┐      │
│ └──────────────────────┘  └──────────────────────┘       │
└──────────────────────────────────────────────────────────┘
```

## 5. UI 资产设计（沉淀到插件）

原生中控台不是一次性页面——它带着一套可复用的插件 UI 资产层落地，偏好页、
未来的详情页都能消费。

### 5.1 目录与装配

```
plugin/addon/content/
  dashboard/
    dashboard.xhtml      # 页面骨架(XUL+html: 混合,同 preferences.xhtml 管线)
    dashboard.css        # 页面布局与组件样式(只消费 token,不写死颜色)
  ui/
    tokens.css           # 设计 token:亮/暗两套(媒体查询切换)
    icons/               # SVG 图标资产(16×16 stroke,currentColor)
      status-running.svg  status-queued.svg  status-failed.svg
      status-succeeded.svg  doc.svg  refresh.svg  spinner.svg
      clear.svg  empty.svg  external.svg  monitor.svg  locate.svg
plugin/src/modules/
  dashboardWindow.ts     # 窗口壳:openDialog+单例+几何+入口(接替 monitorWindow.ts)
  dashboardScript.ts     # 页面逻辑:数据拉取/渲染/SSE,事件经 hooks 派发
```

装配：xhtml 以 `<?xml-stylesheet href="chrome://retainpdf/content/ui/tokens.css"?>`
+ dashboard.css 双样式表引入；脚本零独立文件——`onload` 派发
`Zotero.__addonInstance__.hooks.onDashboardEvent('load', { window })`，逻辑全在
TS bundle（preferenceScript.ts 同款模式）。文案走 addon.ftl 现有 l10n 机制。

### 5.2 设计 token（`ui/tokens.css`）

语义名与网页端契约一一对齐，`--rp-` 前缀防宿主样式冲突；浅色取 classic 值、
深色取 night 值，`prefers-color-scheme` 切换（preferences.css 已验证的同款机制）。
完整草案见附录 A，核心对照：

| 语义 | 浅色（classic） | 深色（night） | 用途 |
|---|---|---|---|
| `--rp-bg` | `#f5f5f7` | `#141618` | 窗体底 |
| `--rp-paper` | `#ffffff` | `#1e2226` | 卡片纸面 |
| `--rp-ink` | `#1d1d1f` | `#e8e6e3` | 主文字/进度条 |
| `--rp-muted` | `#6e6e73` | `#9a9590` | 次要文字 |
| `--rp-line` | `#e5e5ea` | `#2c3238` | 发丝边框 |
| `--rp-accent` | `=--rp-ink` | `=--rp-ink` | classic 哲学：墨块即强调；独立 token 供换肤 |
| `--rp-ok / danger / warn` | `#34c759 / #ff3b30 / #ff9f0a` | `#6bc48a / #e07068 / #d4a24a` | 状态语义（含 `-weak` 底） |
| `--rp-radius-sm/md/lg/xl` | `8 / 12 / 16 / 24px` | 同 | 按钮/tile/卡片/分组面板 |
| `--rp-font-sans` | SF Pro → PingFang SC → Noto Sans CJK | 同 | 与网页端同栈 |
| `--rp-ease-out` | `cubic-bezier(0.23,1,0.32,1)` | 同 | 微交互曲线 |

accent 决策：网页 classic 用「墨色即强调」，中控台照抄（进度条、主按钮都是墨块），
不引偏好页的 Linear 靛蓝——中控台要对齐的是监控台观感；偏好页已有资产不动，
后续可择机把偏好页 token 也迁到 `ui/tokens.css`（非本方案目标）。

### 5.3 图标库（`ui/icons/`）

规格：16×16 viewBox、`fill="none"`、`stroke="currentColor"`、`stroke-width="1.5"`、
round caps/joins；颜色由 CSS `color` 控制，图标文件本身不带颜色；旋转动画由
CSS class 驱动（不用 SMIL）。视觉参照 lucide 同名义（ISC 许可，可描摹同风格，
不直接复制整条 path 资产）：

| 文件 | 语义 | 视觉 | 网页端对应 |
|---|---|---|---|
| `status-running.svg` | 运行中分组 | 脉搏线 | Activity |
| `status-queued.svg` | 排队中分组 | 圆钟 | Clock3 |
| `status-failed.svg` | 失败分组 | 警示三角 | TriangleAlert |
| `status-succeeded.svg` | 已完成分组 | 圆勾 | CheckCircle2 |
| `doc.svg` | 任务卡文档图标 | 文档轮廓 | FileText |
| `refresh.svg` | 刷新按钮 | 环形双箭头 | RefreshCw |
| `spinner.svg` | 加载态 | 缺口圆（CSS 旋转） | LoaderCircle |
| `clear.svg` | 清空分组 | 橡皮 | Eraser |
| `empty.svg` | 空态插图 | 托盘 | Inbox |
| `external.svg` | 打开详情 | 外联箭头 | ExternalLink |
| `monitor.svg` | **工具栏入口图标**（自有） | 仪表盘/示波器，1.75 描边保工具栏辨识度 | —— |
| `locate.svg` | 定位 Zotero 条目（N2 联动预留） | 准星 | Crosshair |

`monitor.svg` 结束「工具栏按钮拿 favicon@0.5x.png 顶事」的现状；toolbarbutton
沿用 `image` 属性 + `list-style-image` 双保险喂法，SVG 失灵时回退渲染 PNG。

### 5.4 组件类清单（`dashboard.css`）

`.rp-dash-header`（eyebrow+标题+刷新）、`.rp-dash-tiles`/`.rp-dash-tile`（计数格）、
`.rp-dash-groups`（双列网格）、`.rp-dash-group`（分组面板+组头+计数 pill+清空钮）、
`.rp-dash-card`（任务卡）、`.rp-dash-pill`（状态 pill，data-status 上色）、
`.rp-dash-progress`（进度条+百分比）、`.rp-dash-btn`（次级按钮）、
`.rp-dash-empty`（空态）、`.rp-dash-skeleton`（首屏骨架）、
`.rp-dash-errorbar`（刷新失败横幅）。

### 5.5 资产纪律

- 组件 CSS 只写 `var(--rp-*)`，禁止颜色字面量（对齐网页端
  `tests/css-color-literals.test.mjs` 的同款禁令思路）。
- 明暗差异只存在于 tokens.css；组件不认识「主题」。
- 图标不带颜色、不带固定尺寸外的 presentation 属性；新增图标先入
  `ui/icons/` 再引用，禁止内联一次性 SVG 散落 TS 里。
- 所有用户可见文案走 ftl；图标一律 `aria-hidden`，状态语义由文字承担。

## 6. 里程碑

| 里程碑 | 内容 | 验收 | 预估 |
|---|---|---|---|
| N0 资产与静态骨架 | tokens.css + 全套图标 + dashboard.css + dashboard.xhtml（假数据渲染） | 真机明暗两主题开窗，与网页监控台截图对照走查「神似」；图标无糊无丢 | 0.5–1 天 |
| N1 数据接通 | `listJobs`/`deleteJob` 补客户端；分组渲染、计数、SSE+3s 轮询、加载/错误/空三态 | 与浏览器监控台同屏对比：列表一致、进度实时刷新；断网给页面内错误态 | 1 天 |
| N2 联动与收尾 | 清空历史、详情外链（`detail_url`）、翻译完成 ProgressWindow 带「打开中控台」；monitorWindow.ts iframe 实现退役（入口/几何迁移）、文档更新 | 真机验收；旧嵌入窗口不再可达 | 0.5 天 |

## 7. 风险

| 风险 | 缓解 |
|---|---|
| chrome xhtml 脚本/样式装配细节 | preferences.xhtml 同管线已验证（onload→hooks、双样式表 PI 是标准 Gecko） |
| SVG 在 toolbarbutton 的版本兼容 | image + list-style-image 双保险先例（v0.1.8 定论）；不济渲染 PNG 回退 |
| 窗口关闭后 SSE/轮询泄漏 | unload 统一 close；请求代际号防回写；轮询兜底不依赖流存活 |
| 与网页监控台观感漂移 | token 契约同源 + N0 截图走查；接受「神似」，不逐像素 |
| Zotero 明暗主题跟随异常 | `prefers-color-scheme` 在 preferences.css 已实测生效 |

## 附录 A：`ui/tokens.css` 草案（可直接落盘）

```css
/* RetainPDF 插件 UI 设计 token —— 语义契约对齐 frontend/web themes/_contract.css。
 * 浅色取 classic 值,深色取 night 值;--rp- 前缀防宿主样式冲突。
 * 组件只消费 var(--rp-*),禁止写死颜色;明暗只改本文件。 */

.rp-dash-root {
  --rp-bg: #f5f5f7;
  --rp-paper: #ffffff;
  --rp-surface: rgba(255, 255, 255, 0.78);
  --rp-ink: #1d1d1f;
  --rp-muted: #6e6e73;
  --rp-line: #e5e5ea;

  --rp-accent: var(--rp-ink); /* classic 哲学:墨块即强调;独立 token 供换肤 */
  --rp-accent-weak: rgba(29, 29, 31, 0.12);

  --rp-danger: #ff3b30;
  --rp-danger-weak: rgba(255, 59, 48, 0.12);
  --rp-ok: #34c759;
  --rp-ok-weak: rgba(52, 199, 89, 0.12);
  --rp-warn: #ff9f0a;
  --rp-warn-weak: rgba(255, 159, 10, 0.14);
  --rp-gold: #b08d3a;
  --rp-gold-weak: rgba(176, 141, 58, 0.14);

  --rp-shadow-color: #0f172a;

  --rp-font-sans: "SF Pro Display", "SF Pro SC", "PingFang SC",
    "Helvetica Neue", "Noto Sans CJK SC", sans-serif;
  --rp-font-mono: "Iosevka", "JetBrains Mono", monospace;

  --rp-radius-sm: 8px; /* 按钮 / pill */
  --rp-radius-md: 12px; /* 计数 tile */
  --rp-radius-lg: 16px; /* 任务卡片 */
  --rp-radius-xl: 24px; /* 分组面板 */

  --rp-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
}

@media (prefers-color-scheme: dark) {
  .rp-dash-root {
    --rp-bg: #141618;
    --rp-paper: #1e2226;
    --rp-surface: rgba(30, 34, 38, 0.88);
    --rp-ink: #e8e6e3;
    --rp-muted: #9a9590;
    --rp-line: #2c3238;

    --rp-accent-weak: rgba(232, 230, 227, 0.14);

    --rp-danger: #e07068;
    --rp-danger-weak: rgba(224, 112, 104, 0.16);
    --rp-ok: #6bc48a;
    --rp-ok-weak: rgba(107, 196, 138, 0.14);
    --rp-warn: #d4a24a;
    --rp-warn-weak: rgba(212, 162, 74, 0.14);
    --rp-gold: #c9a227;
    --rp-gold-weak: rgba(201, 162, 39, 0.16);

    --rp-shadow-color: #000000;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rp-dash-root *,
  .rp-dash-root *::before,
  .rp-dash-root *::after {
    transition: none;
    animation: none;
  }
}
```
