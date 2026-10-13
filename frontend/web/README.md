# RetainPDF Web 状态页

`frontend/web` 是当前生产 Web 前端：一个两页 MPA，只做「查看任务进度」——
完整的产品客户端是 Zotero 插件（`plugin/`），网页端不再承担上传/图书馆/阅读职责。

| 页面 | HTML | React 入口 | 构建产物 |
|------|------|------------|----------|
| 任务列表 | `index.html` | `src/app/home/entry.tsx` | `dist/app.bundle.js` |
| 任务详情 | `detail.html` | `src/app/detail/entry.tsx` | `dist/detail.bundle.js` |

任务列表页复用 `src/features/task-center`（3 秒轮询 `GET /api/v1/jobs`，行点击跳
`detail.html?job_id=…`）；任务详情页由 `src/features/job-detail` 提供
摘要/失败诊断/产物下载/事件时间线。CSS 按页面分别构建到
`dist/css/{home,detail}.css`，HTML 引用的查询参数由构建脚本按内容哈希更新。

## 目录

| 目录 | 说明 |
|------|------|
| `src/app` | 装配层：两页入口与共享启动壳（`shell-boot.ts`） |
| `src/features` | `task-center` / `job-detail`，每个内部分 `ui/` 与 `domain/`，`index.ts` 是唯一出口 |
| `src/platform` | 跨功能基础设施：API 网关、配置、契约、mock、导航 |
| `src/ui` | 共享 UI 组件与 React 原语（shadcn 生成物、hooks、主题） |
| `src/styles` | 两页样式入口与共享层 |
| `scripts` | JS/CSS 构建、静态服务器与 smoke |
| `tests` | Node 单测、架构/契约门禁 |

`src/` 的分层结构与门禁清单见 [`src/FEATURES.md`](src/FEATURES.md)。

## 弹窗 UI 契约

任务详情页的普通弹窗（事件流/阶段时间线模态框）使用 `src/ui/components/dialog.tsx`，
不得调用浏览器 `alert/confirm/prompt`。业务 feature 不得直接导入 Radix Dialog；
`tests/architecture/architecture-boundaries.test.mjs` 会阻止绕开共享边界。

## 常用命令

从仓库根目录运行：

```bash
npm run build:web
npm run test:web
npm --prefix frontend/web run typecheck
```

也可以在本目录运行：

```bash
npm run build            # workspace packages + version + CSS + JS + cache stamp
npm run build:js
npm run build:css
npm run typecheck
npm test
python3 scripts/serve_static.py --host 127.0.0.1 --port 40001 --root .
```

运行时配置由 `runtime-config.js` 提供默认值；本机覆盖写入被 Git 忽略的
`runtime-config.local.js`，可从 `runtime-config.local.example.js` 开始。
不要提交 API Key 或供应商凭据。

## 相关文档

| 文件 | 内容 |
|------|------|
| [`src/FEATURES.md`](src/FEATURES.md) | 页面、领域层与装配边界 |
| [`src/app/detail/README.md`](src/app/detail/README.md) | 详情页职责 |
| [`src/styles/README.md`](src/styles/README.md) | 两页 CSS 构建与归属 |
| [`tests/README.md`](tests/README.md) | 测试命令与测试边界 |
