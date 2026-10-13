# `frontend/web` CSS 架构

两页分别加载独立 CSS，不再共用一份全站样式包：

| HTML | Web 入口 | 样式真值 | 产物 |
|------|----------|----------|------|
| `index.html` | `entries/home.css` | `frontend/web/src/styles/**` | `dist/css/home.css` |
| `detail.html` | `entries/detail.css` | `frontend/web/src/styles/**` | `dist/css/detail.css` |

任务列表页（home）只用 Tailwind 工具类 + 共享层，没有页内领域样式；
`pages/detail/` 是详情页领域样式的唯一落点。

## 目录

```text
frontend/web/src/styles/
├── entries/
│   ├── home.css          # 任务列表页入口
│   └── detail.css        # 详情页入口
├── core/                 # Web 跨页基础样式
├── pages/detail/         # 详情页领域样式
├── pages.css             # 详情页装配入口引用
├── tokens.css / base.css / shadcn-theme.css
├── components*.css / dialog-shell.css
└── themes/               # 皮肤 token（两页 bootTheme 共用）
```
