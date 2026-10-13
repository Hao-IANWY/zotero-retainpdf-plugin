# `frontend/web/src` 结构与依赖边界

本文说明 `src/` 的四层结构、每层的职责、层与层之间允许的依赖方向，
以及这些规则由哪些门禁把守。网页端已收缩为「任务列表 + 任务详情」两页，
完整产品客户端方向是 Zotero 插件（`plugin/`）。

## 总览

```text
frontend/web/src/
├── app/          # 装配层：两页入口、依赖接线
│   ├── home/     #   任务列表页入口 + TaskListApp
│   ├── detail/   #   detail.html 的入口与页面壳
│   ├── bootstrap/#   给 @retainpdf/domain 注入运行时端口
│   └── shell-boot.ts  # 两页共享启动壳（adapters → bootTheme → 挂载）
├── features/     # 2 个产品功能，每个 = 用户能指着界面说出的一件事
├── platform/     # 跨功能基础设施，不知道任何产品功能的存在
├── ui/           # 共享 UI 组件与 React 原语，同样不知道产品功能
├── types/        # ambient 全局声明
├── styles/       # 两页 CSS 入口与主题
└── assets/       # logo
```

## 依赖方向

```
app  ──►  features  ──►  platform
             │              ▲
             └──► ui ───────┘
```

- `app` 可以引用任何一层
- `features` 可以引用 `features`（只经对方出口）、`ui`、`platform`；**不得引用 `app`**
- `ui` 只能引用 `ui`、`platform`
- `platform` 只能引用 `platform`

由 `tests/architecture/layer-boundaries.test.mjs` 把守。

## `features/` —— 一个功能 = 一个目录

2 个目录，对应界面上 2 件事：

| 目录 | 用户看到的 |
|---|---|
| `task-center` | 任务列表页主体：按 运行/排队/失败/完成 分组，行内进度、取消/重试、打开详情 |
| `job-detail` | `detail.html` 任务详情整页：运行信息、失败诊断、产物下载、事件时间线、断点恢复 |

每个功能内部固定两层，`index.ts` 是唯一出口：

```text
features/<功能>/
├── index.ts      # 唯一出口。跨功能只能从这里取
├── ui/           # React 组件与 hooks
└── domain/       # 纯逻辑，**不得 import React**
```

跨功能引用只能落在对方的 `index.js`，不得深入内部——同样有门禁。

## `platform/` —— 跨功能基础设施

| 子目录 | 内容 |
|---|---|
| `api/` | `index.ts` 是唯一 API 网关（`mockable()` 做 mock/真实两路分发） |
| `config/` | 运行时配置、常量、storage keys |
| `contracts/` | 下载动作、书架载荷等跨功能契约 |
| `mock/` | mock 夹具 |
| `navigation/` | 两页 URL 契约与跳转出口 |
| `utils/` `generated/` | 纯工具、构建产物 |

**`features/` 不得绕过 `api/index.ts`** 直连域内实现——绕过会让 mock 模式静默走真网络。

## `ui/` —— 共享 UI

`components/`（shadcn 生成物）、`lib/utils.ts`、`hooks/`、`theme/`、
`context/`、`download-toast/`。

`components.json` 的别名指向 `@/ui` 系列，`npx shadcn add` 会生成到
`ui/components/`。

## 门禁清单

| 文件 | 把守什么 |
|---|---|
| `tests/architecture/layer-boundaries.test.mjs` | 四层方向、跨功能只经出口、domain 禁 React、Tailwind `@source` 目录存在 |
| `tests/architecture/architecture-boundaries.test.mjs` | 防回弹（不得 import 已删除的旧世界）、旧目录不得复活、共享 dialog 边界 |
| `tests/architecture/page-dom-references.test.mjs` | 两页的 DOM id/class 引用必须有归属，防运行时静默失效 |
| `tests/architecture/tsx-color-literals.test.mjs` | 主题盲颜色只减不增 |
| `tests/architecture/shell-smoke.test.mjs` | 两页挂载顺序与入口链路 |

改动这些门禁时，**必须注入一个已知违规确认它仍能报错，再移除**。
只看「测试通过」不足以说明门禁有效——历史上查出过四条一直在空转的门禁，
都是「测试常绿」但实际扫 0 个文件或整片豁免。

## 历史

`src/` 曾长期是 `js/` + `pages/` 的双树结构。2026-09 的批次 1–5 重组为四层；
2026-10 网页端收缩为任务状态两页，图书馆/阅读器/凭据等功能随桌面端一并退役，
迁移记录见 `docs/ops/planning/frontend-migration/feature-layout-blueprint.md`。
