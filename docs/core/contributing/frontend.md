# 前端贡献指南

桌面端已退役（2026-10 随网页端收缩一并删除），网页端只剩两页形态；
完整的产品客户端是 Zotero 插件（`plugin/`）。

## 目录边界

- `frontend/web/`：当前生产使用的静态前端源码（`front-tailwind-ui`），两页 MPA：
  任务列表（`index.html`）+ 任务详情（`detail.html`），只做「查看任务进度」。
- `frontend/packages/*`：`domain` / `ui` / `api` 三个共享包，web 与插件契约靠它们对齐。
- `plugin/`：Zotero 插件，独立锁文件、独立发版，不在根 workspaces。

## 本地启动

先在仓库根目录安装统一锁定的 workspace 依赖：

```bash
npm ci
```

根目录的 `package-lock.json` 是 `frontend/*` 与 `packages/*` 的唯一正式 npm
锁文件。不要在 workspace 内提交独立的 `package-lock.json`。

```bash
cd frontend/web
python3 scripts/serve_static.py --host 127.0.0.1 --port 40001 --root .
```

默认端口：

- Web 前端：`40001`
- Rust API：`41000`

前端 API base 规则见 [本地启动与配置](../api/local-dev.md)。

## 改动规则

- UI 逻辑优先放到 `src/features` 下的 feature 模块（`ui/` 与 `domain/` 分层，
  `index.ts` 是唯一出口），不要把新流程塞回入口文件。
- 前端需要新增 API 字段时，先确认后端是否有稳定 view/projection，不要让前端
  从内部 payload、raw artifact 或数据库字段里猜。
- 分层结构与门禁清单见 [`frontend/web/src/FEATURES.md`](../../frontend/web/src/FEATURES.md)。

## 常用检查

```bash
npm run build:web
npm run verify:web
```

前端端到端状态 smoke 会真实提交任务，通常需要本地 Rust API、OCR token、模型 key 和样本 PDF；具备这些条件时再跑：

```bash
cd frontend/web
npm run smoke:status -- --file ../../data/temPDF/test1.pdf
```
