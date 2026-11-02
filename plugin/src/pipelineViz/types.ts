// 跨 chunk 类型契约：主 bundle（dashboardViz）只 import type 本文件，编译期
// 拿到引擎接口形状，运行期不产生任何对 three 的依赖——三维实现在懒 chunk
//（entry.ts）里，两个 bundle 间唯一的运行期边界是窗口上的 RetainPDFPipelineViz
// 全局对象（见 dashboardViz 的 ensurePipelineScript）。

import type { EngineOptions, PipelineSceneEngine } from "./scene/engine";

/** 懒 chunk 注入到中控台窗口的全局对象形状。 */
export interface PipelineVizGlobal {
  createEngine(
    container: HTMLElement,
    opts?: EngineOptions,
  ): PipelineSceneEngine;
  /** 机位数量（全景 + 五站聚焦），机位文案由主 bundle 经 FTL 出。 */
  cameraCount: number;
}
