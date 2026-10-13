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

- 兼容范围：manifest 必须写 `strict_max_version: "*"`——实测 Zotero 10：上限不写
  会被当未适配拒装，写死 `8.*`/`10.0.*` 又会在下个大版本拒装；`"*"` 是 Zotero
  官方测试插件的写法。`strict_min_version` 保持 6.999，兼容问题由真实 API 报告驱动修复。
