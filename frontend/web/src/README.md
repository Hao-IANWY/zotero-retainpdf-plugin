# `frontend/web/src` 目录说明

生产 Web 前端源码根。两页 MPA（任务列表 / 任务详情）共享本目录，构建产物见
`../scripts/build-js-bundle.mjs`（JS）与 `../scripts/build-css.mjs`（CSS）。完整地图与
门禁清单见 [`FEATURES.md`](FEATURES.md)；样式归属见 [`styles/README.md`](styles/README.md)；
测试规矩见 `../tests/README.md`。

## 四层结构与依赖方向

```text
app  ──►  features  ──►  platform
             │              ▲
             └──► ui ───────┘
```

- `app` 可引用任何一层；`features` 不得引用 `app`；
  `ui` 只能引用 `ui`、`platform`；`platform` 只引用 `platform`。
- 跨功能引用只能落在对方的 `index.ts` 出口，不得深入内部。
- `tests/architecture/layer-boundaries.test.mjs` 把守以上全部。

## `app/` —— 装配层：两页入口

| 目录 | 说明 |
|---|---|
| `home/` | 任务列表页：`entry.tsx`（`dist/app.bundle.js` 入口）+ `TaskListApp.tsx`（挂 TaskCenter） |
| `detail/` | 任务详情页：`entry.tsx` + `DetailApp.tsx`（整页编排，命令式孤岛较多） |
| `bootstrap/` | 给 `@retainpdf/domain` 注入运行时端口 |
| `shell-boot.ts` | 两页共享启动壳（adapters → 主题 → 找根挂载，不开 StrictMode） |

## `features/` —— 2 个产品功能

`task-center`（任务列表）、`job-detail`（任务详情整页）。每个功能固定结构：
`index.ts` 唯一出口 + `ui/`（React 组件）+ `domain/`（纯逻辑，**禁 React**）。

## `platform/` —— 跨功能基础设施

| 目录 | 说明 |
|---|---|
| `api/` | `index.ts` 是唯一 API 网关（`mockable()` 做 mock/真实两路分发） |
| `config/` | 运行时配置、常量、storage keys |
| `contracts/` | 下载动作、书架载荷等跨功能契约 |
| `mock/` | mock 数据与夹具 |
| `navigation/` | 两页 URL 契约与跳转出口 |
| `utils/`、`generated/` | 纯工具函数、构建生成物 |

## `ui/` —— 共享 UI 组件与 React 原语

`components/`（shadcn 生成物；`dialog.tsx` 普通弹窗是全站唯一弹窗壳）、
`lib/utils.ts`、`hooks/`、`theme/`（主题注册）、`context/`、`download-toast/`。
弹窗外层样式真值在 `styles/dialog-shell.css`；`Button.tsx` 与
`components/button.tsx` 必须保持两级（macOS 大小写不敏感）。

## 配套目录

| 目录 | 说明 |
|---|---|
| `types/` | 全局 ambient 声明 |
| `styles/` | 两页 CSS：`entries/{home,detail}.css`、`core/` 跨页基础、`pages/detail/` 领域样式、tokens/base/dialog-shell 共享契约 |
| `assets/` | logo |
| `FEATURES.md` | 本目录地图与门禁清单（真值） |
