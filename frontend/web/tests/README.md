# `frontend/web` 测试指南

这里的测试使用 Node.js 内置的 `node:test`。默认测试命令会先加载
`helpers/register-jsx.mjs`，因此测试可以直接导入 TypeScript、TSX 和 JSX；显式的
`.js`/`.jsx` 路径也会优先解析到同名 `.ts`/`.tsx` 文件。

## 目录分类

| 目录 | 放置内容 |
| --- | --- |
| `architecture/` | 源码分层、依赖方向、CSS/DOM 约束和测试布局门禁 |
| `contracts/` | JSON Schema、API DTO、事件名及跨包数据契约 |
| `jobs/` | 任务标准化、事件、下载与错误处理 |
| `platform/` | platform 层的 mock 与传输契约 |
| `shared/` | 被两页共同使用的客户端、hook 与组件 |
| `status/` | 任务详情页的状态展示与阶段进度 |
| `task-center/` | 任务列表页的列表/发现/首屏 |
| `helpers/` | 测试加载器、共享基线和跨目录复用的测试工具，不放测试用例 |

测试文件必须放在上述职责最接近的领域目录中；`tests/` 根目录不允许出现
`*.test.mjs`。`architecture/test-layout.test.mjs` 会持续检查这条规则。

## 运行测试

从仓库根目录运行全量测试：

```sh
npm --prefix frontend/web test
```

运行单个文件或一个目录：

```sh
npm --prefix frontend/web test -- tests/reader/markdown-math.test.mjs
npm --prefix frontend/web test -- 'tests/contracts/*.test.mjs'
```

修改 TypeScript、TSX 或包边界后，同时运行：

```sh
npm --prefix frontend/web run typecheck
npm --prefix frontend/web test -- 'tests/architecture/*.test.mjs'
```

视觉回归检查与基线更新是独立流程：

```sh
npm --prefix frontend/web run visual:check
npm --prefix frontend/web run visual:update   # 仅在确认视觉变化符合预期后执行
```

不要绕过 package script 直接运行普通 `node --test`，否则 TS/TSX、`@/` 和
`@retainpdf/*` 的测试解析规则不会完整生效。

## 命名和放置规则

- 文件统一命名为 `<能力或场景>.test.mjs`，名称描述被验证的行为，例如
  `reader-markdown-panel.test.mjs`。
- 按被测能力放置，而不是按实现文件扩展名放置。跨层不变量优先放
  `architecture/`，跨端数据形状优先放 `contracts/`。
- 新测试应使用 `node:test` 和 `node:assert/strict`，保持测试可独立运行。
- 只对当前测试所需的浏览器 API 建立 jsdom 或最小 stub，并在测试结束时清理
  DOM、定时器、订阅和全局状态。
- 可复用的加载或基线设施放入 `helpers/`；不要把业务断言藏在 helper 中。常用的有：
  - `helpers/async.mjs`：`wait` / `waitFor`（回传谓词的值，超时描述可以是惰性函数）/ `deferred`
  - `helpers/dom.mjs`：`makeDom`（装 jsdom 全局，key 列表可覆盖）、`installReaderDom`
    （带 `restore()`）、`byId` / `click` / `clickWithMouseDown` / `typeInput` / `selectOption`
  - `helpers/home-app.mjs`：`bootHomeApp` 把整个 HomeApp 挂进 jsdom
  - `helpers/source-text.mjs`：对源码文本断言前先剥注释（`code` / `body`）、用两个锚点切
    片（`region`）、`importSpecifiers`
- 只在一个目录里复用的夹具放该目录的 `helpers/`（如 `home/helpers/`、`reader/helpers/`）。
- 单个文件一般不超过 ~800 行；超过时按主题拆分，用例整块搬移。

## Import 边界

- Web 源码可用 `@/…`；测试加载器会把它解析到 `frontend/web/src/`。
- Job 与 Job Status 只能从 `@retainpdf/domain/job` 和
  `@retainpdf/domain/job-status` 的公开入口导入。禁止深层包导入、相对导入
  `frontend/packages/domain/src/{job,job-status}`，也禁止重新依赖已移除的
  `frontend/web/src/js/{job,job-status}` 镜像（该目录已在批次 5B 整体删除）。
- 需要验证公开行为时，从包的 `exports` 入口导入，例如 `@retainpdf/reader`。
  Reader 内部实现的白盒单元测试可以留在 `reader/` 中直接指向
  `frontend/packages/reader/src`；这不允许生产代码越过 Reader 的公开边界。
- 读取 Domain 源文件文字属于少数契约白盒例外。新增例外必须在
  `architecture/test-layout.test.mjs` 的 `sourceWhiteboxAllowlist` 中显式登记并说明
  原因，不能靠换一种路径写法绕过门禁。
- 不要因为测试 loader 能解析 workspace 源码，就把源码路径当作稳定的公共 API。

## 添加测试清单

- [ ] 测试放在正确的领域目录，文件名以 `.test.mjs` 结尾。
- [ ] 优先通过公开 API 验证行为；确需白盒测试时明确记录边界理由。
- [ ] 没有新增 Domain 深层导入、旧 Web 镜像依赖或生产侧 Reader 源码直连。
- [ ] 测试没有依赖执行顺序，并清理了自身创建的全局状态和资源。
- [ ] 单个测试文件通过。
- [ ] `tests/architecture` 通过；涉及类型时 `typecheck` 通过。
- [ ] 提交前全量 `npm --prefix frontend/web test` 通过。
- [ ] 涉及可见 UI 变化时运行 `visual:check`，只有确认变化后才更新基线。
