# 前端文档

这里存放当前生产前端的架构、联调和状态检查资料。
网页端已收缩为「任务列表 + 任务详情」两页（2026-10），完整产品客户端方向是
Zotero 插件（plugin/）。

- [后端改动交接](./backend-changes-handoff.md) —— 需要前端配合的新端点/新字段/新错误码
- [前端状态 Smoke](./status_smoke.md)
- [统一 React SPA 目标架构](./spa-architecture.md)（历史设计存档）
- [主题皮肤系统](./theme-system/THEME_SYSTEM.md)
- [历史前端优化记录](../../ops/reports/frontend-optimization-notes.md)
- [React 迁移计划与审计](../../ops/planning/frontend-migration/)（历史存档）
- [前端状态 Smoke 最新报告](../../ops/reports/frontend-status-smoke-latest.json)

主要代码入口：

- `frontend/web/src/app/`（装配层：home 任务列表 / detail 任务详情）
- `frontend/web/src/features/`（task-center 任务列表 / job-detail 任务详情）
- `frontend/web/src/platform/`、`frontend/web/src/ui/`
- `frontend/web/src/styles/`
- `frontend/packages/ui/`

桌面端已退役（2026-10 随网页端收缩一并删除）。
