# zotero-retainpdf-plugin

RetainPDF 的 Zotero 7+ 客户端插件（含 Zotero 10）（TypeScript，zotero-plugin-template 底座，AGPL-3.0）。

## 文档治理

- `docs/` 是唯一文档根；新增文档归入 adr / ops 并从对应 README 建入口。
- 服务端 API 契约以 retain-pdf 仓库 `docs/api/` 为准，本仓库不另立字段定义。
- 里程碑进度记在 `docs/ops/planning/milestones.md`，只追加结论行。

## 代码约定

- clean-room 红线：可读上游 zotero-pdf2zh 源码学习行为，一行代码不复制。
- API 消费纪律：主状态只读 `display_stage`/`substage`，主线进度只读 `lane=main`，
  `message` 只是文案；请求不带 `X-API-Key`——服务端访问控制由部署层（内网直连）
  兜底，插件侧不再暴露密钥设置；OCR 引擎（mineru/paddle）与 LLM 接口
  （官方 DeepSeek 预置 / 自定义）在偏好页做成分段选项，凭据/模型/并发随任务携带
  （prefs 前置）。

- 监控台窗口（`src/modules/monitorWindow.ts`）：Dialog 非模态大窗内嵌 XUL
  `<browser>` 直接加载监控台现网 HTML——禁止在插件里重做任何监控台 UI；
  地址恒为 `serverBaseURL`（web 入口同原点），不开单独配置；唯一入口 =
  搜索栏右侧按钮（`#zotero-items-toolbar` 注入，`zotero-tb-search` 右邻；
  Zotero 7 没有 `#zotero-toolbar`，菜单一律不挂）；`<browser>` 必须显式
  `type="content"`（chrome 文档默认按 chrome 权限加载，远程 URL 会被 Gecko
  静默拒绝成白屏）且 Dialog 的 about:blank 文档要补 `html,body{height:100%}`
  + browser 用 vw/vh（XUL flex 链对塌缩 body 算百分比会归零）；
  开窗前探测 `{root}/index.html`，错址不开空窗；
  v1 仅支持无边缘认证直连（本机/内网/tailscale），Cloudflare Access 公网
  形态此窗口天然不可用。
- 密钥输入框一律明文（`type="text"`）：Gecko 原生 reveal-password 眼睛与
  插件注入眼睛会叠加成两只，2026-10-14 老板拍板全明文，禁止再引回
  `type="password"` 或任何显隐切换按钮。
- 兼容范围：manifest 必须写 `strict_max_version: "*"`——实测 Zotero 10：上限不写
  会被当未适配拒装，写死 `8.*`/`10.0.*` 又会在下个大版本拒装；`"*"` 是 Zotero
  官方测试插件的写法。`strict_min_version` 保持 6.999，兼容问题由真实 API 报告驱动修复。
