# Zotero 插件内嵌监控台窗口

> 状态：M0–M2 代码就绪 · 2026-10-14 立项并同日实现（v0.1.7）；
> 待真机 spike 验收（Zotero 7/10 的加载、跳转、SSE）。
> 实现取舍：开窗前探测 `GET {root}/index.html` 拦截错址（实测 rust_api :41000
> 返回 404、web 入口 :40001 返回 200），错址不开空窗直接给可操作提示；
> 运行中断网由 Gecko 自带 neterror 页兜底，未做插件级窗口内错误页。
> 前置：[Zotero 插件施工图](./completed/zotero-plugin-development.md)（M0–M2 已落地，
> 翻译链路可用）。窗口形态参考
> [zotero-AI-Butler](https://github.com/steven-jianhao-li/zotero-AI-Butler) 的
> AI 管家主窗口（AGPL-3.0，只读形态不抄代码，延续 clean-room 纪律）。
> 监控台本体是 [frontend/web](../../../frontend/web/) 的「任务列表 + 详情」两页，
> 本文不重新定义其内容。

## 1. 目标与边界

在 Zotero 内开一个窗口直接显示监控台，盯任务进度不再要求开浏览器。

- 展示内容与监控台完全一致：**窗口内嵌浏览器元素直接加载监控台现网 HTML**，
  插件不重新实现任何列表/详情/进度 UI；监控台后续改版，插件零跟进。
- 非目标：在 Zotero 内重做监控台组件；改动监控台自身功能；适配公网
  Cloudflare Access 形态（见 §3 鉴权约束）。

## 2. 窗口形态（对标 AI 管家）

AI Butler 的做法（与我们同为 zotero-plugin-template 底座）：`ztoolkit.Dialog`
大尺寸非模态对话框作主窗口容器，内部绑定真实 `openDialog`，标签页切换子视图。
我们不需要多标签，形态更简——一个窗口就是一个内容区：

- 载体：`ztoolkit.Dialog` 非模态窗口，内部撑满一个内嵌浏览器元素
  （chrome 文档内嵌远程页面的 XUL `<browser>` / `<iframe type="content">`，
  M0 真机 spike 定具体元素），src 指向 `{监控台根}/index.html`。
- 入口：主窗口「工具」菜单 + 条目右键菜单各加「RetainPDF 监控台」（locale
  文案随偏好页一起补）；窗口单例——已开则聚焦，不重复开。
- 尺寸：默认约 1100×750，关闭时记住窗口几何（pref 持久化）。
- 同源零改造：iframe 内页面 origin 就是 web 容器，监控台 `runtime-config.js`
  的 `apiBase` 为空即同源，fetch/SSE 行为与浏览器完全一致，前端与插件两侧
  都不动代码。

已否方案：把监控台构建产物打进插件、页面内 fetch 指向远端 API——CORS、鉴权、
runtime-config 注入都要重新造一遍，且前端每次改版都要跟着发插件版，与
「内容完全一致」的目标背道而驰。

## 3. URL 解析与鉴权

- 新增 pref `monitorUrl`（可选）。留空时取 `serverBaseURL` 推导：docker 交付的
  web 容器同原点服务控制台静态页（`location /`）与 `/api/`、`/health` 反代
  （ops/deployment/docker/nginx.conf.template），插件指到 web/nginx 入口时
  监控台根就是 `serverBaseURL` 本身。
- `serverBaseURL` 直指 rust_api（如 `:41000`）时控制台不在那里，加载失败，
  窗口内错误页提示用户填 `monitorUrl` 或把 Base URL 改指 web 入口。
- 鉴权约束：iframe 导航无法注入自定义请求头，公网 Cloudflare Access
  （OTP / Service Token）形态此窗口不可用；v1 仅支持无边缘认证的直连形态
  （本机 / 内网 / tailscale）。服务端 `RUST_API_KEYS` 当前为空（匿名模式），
  窗口内无需任何凭据；将来服务端上锁时窗口同样过不去，届时再议
  （候选：URL 参数钥匙，或文档写明窗口仅限匿名/内网部署）。
- 加载失败（断网 / 错址 / Access 拦截页）：窗口内给插件级错误页与
  「检查连接」按钮（复用 `/health`），不裸挂白屏。

## 4. 里程碑

| 里程碑 | 内容 | 验收 | 预估 |
|---|---|---|---|
| M0 窗口 spike | Dialog 窗口 + 内嵌浏览器元素加载监控台 + 工具/右键菜单入口；真机验证 Zotero 7 与 10：页面加载、列表→详情跳转、SSE 进度刷新 | 窗口内看到与浏览器一致的任务列表与详情，进度实时刷新 | 0.5–1 天 |
| M1 生命周期与兜底 | 单例聚焦、几何记忆、加载失败错误页（复用 `/health`）、`monitorUrl` 进偏好页 | 断网/错址时窗口给出可操作提示而非白屏 | 0.5 天 |
| M2 体验收尾 | `target=_blank` 链接拦截策略（转外部浏览器或容忍）、翻译完成后 ProgressWindow 文案提示可开监控台、文档更新 | 真机验收 | 0.5 天 |

与施工图 M3（批量与配置）/M4（分发）无依赖，可穿插推进。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| chrome 文档内嵌远程页面在 Zotero 10 行为变化 | M0 真机 spike 先行；不通则退 `window.openDialog` + browser 元素，再不通 `Zotero.launchInBrowser` 兜底 |
| Access/OTP 公网部署形态不可用 | 文档写明仅直连形态；公网场景继续用浏览器 |
| 详情页 `target=_blank` 链接在 iframe 内无默认行为 | M2 拦截转外部浏览器；v1 容忍 |
| 窗口内可见全量任务（含其他客户端提交的） | 与浏览器监控台语义一致，正是目标，不引入过滤 |
