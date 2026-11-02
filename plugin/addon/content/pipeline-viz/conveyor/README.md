# 三维流水线的传送带资产

来源：设计资产库 `02-G6-0004`（RetainPDF 文献翻译流程可视化演示自带，2026-11-02 提取）。
运行时由 `src/features/pipeline-viz/ui/scene/conveyor.ts` 按本目录地址动态加载：
`/src/assets/pipeline-viz/conveyor/asset.mjs`（fetch + `DecompressionStream('gzip')` 解包，
不进 JS bundle）。加载失败或环境不支持（如桌面 `file://` 下 fetch 不可用）时，
场景回退到参数化简化传送带，功能完整。

- `asset.mjs` / `loader.mjs` / `orientation.mjs` / `orientation.json`：装载器与朝向数据
- `data.json.gz` / `pack-{1,2,3}.bin.gz`：几何与贴图数据包（gzip）
- `receipt.json`：资产清单（来源校验）
- `THREE-LICENSE.txt`：Three.js 许可（资产装载器构建时引用的 Three.js 条款）
- 规划见 `docs/ops/planning/pipeline-viz/`（主规划 20261101、等待队列增补 20261102）
