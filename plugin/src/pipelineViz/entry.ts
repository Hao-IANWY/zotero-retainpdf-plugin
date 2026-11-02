// 三维流水线懒 chunk 的入口：本文件（连同 three 与场景层）由 zotero-plugin
// build 打成独立的 content/scripts/retainpdf-pipeline.js，不进主 bundle——
// 中控台首次切「三维」时由 dashboardViz 注入 <script> 加载。加载后全局对象
// RetainPDFPipelineViz 落在【中控台窗口】作用域：three 内部的 document /
// requestAnimationFrame / ResizeObserver 因此天然属于该窗口，canvas 创建、
// 事件装配与 rAF 生命周期（关窗即停）全部同源，无跨 realm DOM 收养问题。

import { createPipelineSceneEngine } from "./scene/engine";
import { CAMERA_PRESETS } from "./scene/cameras";
import type { PipelineVizGlobal } from "./types";

const globalObject = globalThis as unknown as Record<
  string,
  PipelineVizGlobal | undefined
>;

globalObject.RetainPDFPipelineViz = {
  createEngine: createPipelineSceneEngine,
  cameraCount: CAMERA_PRESETS.length,
};
