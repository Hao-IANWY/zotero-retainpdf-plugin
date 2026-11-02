import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { appendPluginLog } from "../utils/log";
import { RetainPdfClient } from "../api";
import {
  buildPipelineSceneModel,
  sceneModelToEngineInput,
  PIPELINE_STATION_KEYS,
} from "../pipelineViz/scene-model";
import type {
  PipelineHeadlineKind,
  PipelineSceneModel,
  PipelineStationKey,
} from "../pipelineViz/scene-model";
import type { PipelineVizGlobal } from "../pipelineViz/types";
import type { DashState } from "./dashboardScript";

/**
 * 中控台三维流水线视图（网页端 pipeline-viz 的移植宿主，等价于网页端
 * PipelineVizPanel + PipelineVizOverlay 两层的职责）：
 * - 懒 chunk 注入：three 与场景层在 retainpdf-pipeline.js，首次进入三维
 *   视图时以 <script> 注入【中控台窗口】——引擎的 document/rAF 因此属于
 *   该窗口，主 bundle 零 three（对齐网页端懒 chunk 门禁）。
 * - 数据取数纪律：五站映射依赖实时 display_stage，而列表接口
 *   include_live_stage=false 只有存储摘要——聚焦任务每拍轮询补一次 getJob
 *   详情；统一百分比与阶段说明优先 SSE(lane=main)。
 * - 快照驱动：引擎 update 只吃 sceneModelToEngineInput 的数值输出；
 *   悬浮层每拍全量重算、按签名重建（同列表卡片的防抖纪律）。
 * - 降级链（网页端同款）：WebGL 不可用/上下文丢失/引擎建不起来 → 视图切
 *   回列表（onExitToList 回调，不自动恢复），切换按钮禁用并说明原因。
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";
const QUEUE_DISPLAY_LIMIT = 8;
type FtlKey = Parameters<typeof getString>[0];

/** 悬浮层节点缓存：内容分区每拍重建，工具条/机位坞常驻、只搬动位置。 */
interface OverlayRefs {
  overlay: HTMLElement;
  summary: HTMLElement;
  rail: HTMLElement;
  queue: HTMLElement | null;
  activity: HTMLElement | null;
  toolbar: HTMLElement;
  dock: HTMLElement;
}

export interface VizState {
  /** 聚焦任务：null = 尚未选定（进入视图/焦点失效时按 running>queued>最新 选）。 */
  focusJobId: string | null;
  /** getJob 详情缓存（display_stage 的实时来源）。 */
  jobDetail: any;
  scriptPromise: Promise<PipelineVizGlobal | null> | null;
  engine: import("../pipelineViz/scene/engine").PipelineSceneEngine | null;
  unavailable: boolean;
  unavailableReason: string;
  cameraCount: number;
  cameraIndex: number;
  autoRotate: boolean;
  animationPaused: boolean;
  overlay: OverlayRefs | null;
  overlaySignature: string;
  eventsWired: boolean;
  /** 降级时由宿主执行的「切回列表」回调（renderAll 会收起三维视图）。 */
  onExitToList: (() => void) | null;
}

function el(
  win: Window,
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const node = win.document.createElementNS(HTML_NS, tag) as HTMLElement;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function byId(win: Window, id: string): HTMLElement | null {
  return win.document.getElementById(id) as HTMLElement | null;
}

function jobTitle(job: any): string {
  const label = `${job?.display_name || job?.title || ""}`.trim();
  return label || getString("dashboard-unnamed");
}

function stationLabel(key: PipelineStationKey): string {
  return getString(`dashboard-viz-station-${key}` as FtlKey);
}

function headlineText(kind: PipelineHeadlineKind, detail: string): string {
  if (kind === "detail") return detail;
  return getString(`dashboard-viz-headline-${kind}` as FtlKey);
}

function activityStatusText(status: string): string {
  const key = `dashboard-viz-activity-${status}` as FtlKey;
  const text = getString(key);
  // FTL 缺键时 getString 原样返回带前缀的 id——退回「其他」文案而不是裸 id。
  return text.startsWith("dashboard-viz-activity-")
    ? getString("dashboard-viz-activity-other")
    : text;
}

/** WebGL 可用性探测：中控台窗口里开一张一次性画布试上下文。 */
function supportsWebGL(win: Window): boolean {
  try {
    const canvas = win.document.createElementNS(
      HTML_NS,
      "canvas",
    ) as HTMLCanvasElement;
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** 懒 chunk 注入：同一窗口只注入一次，加载后全局对象落在窗口作用域。 */
function ensurePipelineScript(win: Window): Promise<PipelineVizGlobal | null> {
  const scope = win as unknown as Record<string, unknown>;
  const existing = scope.RetainPDFPipelineViz as PipelineVizGlobal | undefined;
  if (existing) return Promise.resolve(existing);
  if (!scope.__retainpdfPipelineScript) {
    scope.__retainpdfPipelineScript = new Promise((resolve) => {
      const script = el(win, "script") as HTMLScriptElement;
      script.src = `chrome://${config.addonRef}/content/scripts/${config.addonRef}-pipeline.js`;
      script.addEventListener("load", () => {
        resolve((scope.RetainPDFPipelineViz as PipelineVizGlobal) ?? null);
      });
      script.addEventListener("error", () => resolve(null));
      win.document.documentElement?.appendChild(script);
    });
  }
  return scope.__retainpdfPipelineScript as Promise<PipelineVizGlobal | null>;
}

/** 焦点选择：运行中最先，其次排队，否则最新一条（展示终态场景）。 */
function pickFocusJob(items: any[]): any | null {
  if (items.length === 0) return null;
  const statusOf = (job: any) => `${job?.status || ""}`.trim().toLowerCase();
  return (
    items.find((job) => statusOf(job) === "running") ??
    items.find((job) => statusOf(job) === "queued") ??
    items[0]
  );
}

/**
 * 进入三维视图（视图切换时调用，不是每拍）：选焦点 → WebGL 探测 → 注入
 * 懒 chunk → 建引擎与悬浮层 → 首拍渲染。引擎已存在（列表/三维来回切）
 * 时只重选焦点并补一拍。
 */
export function enterViz(
  win: Window,
  state: DashState,
  onExitToList: () => void,
): void {
  let viz = state.viz;
  if (!viz) {
    viz = {
      focusJobId: null,
      jobDetail: null,
      scriptPromise: null,
      engine: null,
      unavailable: false,
      unavailableReason: "",
      cameraCount: PIPELINE_STATION_KEYS.length + 1,
      cameraIndex: 0,
      autoRotate: false,
      animationPaused: false,
      overlay: null,
      overlaySignature: "",
      eventsWired: false,
      onExitToList: null,
    };
    state.viz = viz;
  }
  viz.onExitToList = onExitToList;
  if (viz.unavailable) {
    viz.onExitToList();
    return;
  }
  const focus = pickFocusJob(state.items);
  viz.focusJobId = focus ? `${focus?.job_id || ""}`.trim() : null;
  viz.jobDetail = null;
  viz.overlaySignature = "";

  if (viz.engine) {
    // 二次进入：引擎保留（悬浮层/接线都在），只重选焦点补拍。
    updateViz(win, state);
    refreshVizFocusDetail(win, state);
    return;
  }
  if (!supportsWebGL(win)) {
    markUnavailable(win, state, getString("dashboard-viz-unsupported"));
    return;
  }
  const loading = byId(win, "rp-dash-viz-loading");
  loading?.removeAttribute("hidden");
  viz.scriptPromise ??= ensurePipelineScript(win);
  viz.scriptPromise
    .then((globalObject) => {
      // 用户已切回列表/窗口已换代:静默放弃,loading 由 exitViz 收。
      if (state.viz !== viz || !state.vizActive) return;
      if (!globalObject) {
        markUnavailable(win, state, getString("dashboard-viz-init-failed"));
        return;
      }
      viz.cameraCount = globalObject.cameraCount;
      const container = byId(win, "rp-dash-viz-viewport");
      if (!container) {
        markUnavailable(win, state, getString("dashboard-viz-init-failed"));
        return;
      }
      viz.engine = globalObject.createEngine(container, {
        onContextLost: () =>
          markUnavailable(win, state, getString("dashboard-viz-context-lost")),
      });
      buildOverlay(win, viz);
      wirePanelEvents(win, state, viz);
      loading?.setAttribute("hidden", "hidden");
      updateViz(win, state);
      refreshVizFocusDetail(win, state);
    })
    .catch((error: unknown) => {
      void appendPluginLog(`[dashboard-viz] engine init failed: ${error}`);
      markUnavailable(win, state, getString("dashboard-viz-init-failed"));
    });
}

/** 离开三维视图（切回列表）：只收引擎（rAF/GPU），悬浮层与接线留给再进入。 */
export function exitViz(win: Window, state: DashState): void {
  const viz = state.viz;
  if (!viz) return;
  disposeEngine(viz);
  byId(win, "rp-dash-viz-viewport")?.replaceChildren();
  byId(win, "rp-dash-viz-loading")?.setAttribute("hidden", "hidden");
}

/**
 * 每拍渲染入口（renderAll / SSE / 详情回包共用）：重算模型 → 推引擎 +
 * 按签名重建悬浮层。焦点任务被清掉时重选焦点。
 */
export function updateViz(win: Window, state: DashState): void {
  const viz = state.viz;
  if (!viz || !state.vizActive || viz.unavailable) return;
  if (
    viz.focusJobId &&
    !state.items.some((job) => `${job?.job_id || ""}`.trim() === viz.focusJobId)
  ) {
    const next = pickFocusJob(state.items);
    viz.focusJobId = next ? `${next?.job_id || ""}`.trim() : null;
    viz.jobDetail = null;
  }
  // 首拍前就进入三维视图(数据未到)的情况:首拍数据到位时自动补选焦点。
  if (!viz.focusJobId) {
    const next = pickFocusJob(state.items);
    viz.focusJobId = next ? `${next?.job_id || ""}`.trim() : null;
    viz.jobDetail = null;
  }
  const focusId = viz.focusJobId;
  if (!focusId) return;

  const listed = state.items.find(
    (job) => `${job?.job_id || ""}`.trim() === focusId,
  );
  const detail = viz.jobDetail?.job_id === focusId ? viz.jobDetail : null;
  const job = detail ?? listed ?? null;
  const live = state.live.get(focusId);
  const percent =
    live?.percent != null
      ? live.percent
      : listed
        ? snapshotPercentOf(listed)
        : null;

  const model = buildPipelineSceneModel({
    job,
    ocrJob: state.items.find(
      (item) => `${item?.job_id || ""}`.trim() === `${focusId}-ocr`,
    ),
    jobs: state.items,
    overallPercent: percent,
    liveDetail: live?.stageDetail || "",
    reducedMotion: prefersReducedMotion(win),
  });
  viz.engine?.update(sceneModelToEngineInput(model));
  if (viz.overlay) {
    renderOverlay(win, viz, model, job ? jobTitle(job) : "");
  }
}

/**
 * 聚焦任务的详情补拉（列表摘要没有实时 display_stage）。loadJobs 每拍与
 * 焦点切换后调用；回包仍属当前焦点才回写并触发一拍渲染。
 */
export function refreshVizFocusDetail(win: Window, state: DashState): void {
  const viz = state.viz;
  if (!viz || !state.vizActive || viz.unavailable || !viz.focusJobId) return;
  const jobId = viz.focusJobId;
  new RetainPdfClient()
    .getJob(jobId)
    .then((detail) => {
      if (state.viz !== viz || !state.vizActive || viz.focusJobId !== jobId)
        return;
      viz.jobDetail = detail;
      updateViz(win, state);
    })
    .catch(() => {
      // 详情拉不到就用列表摘要兜底，不记错误条（下一拍还会再试）。
    });
}

/** SSE 打点（lane=main/diagnostic）后的轻量刷新入口。 */
export function pokeViz(win: Window, state: DashState, jobId: string): void {
  const viz = state.viz;
  if (!viz || !state.vizActive) return;
  if (viz.focusJobId === jobId) updateViz(win, state);
}

/** 降级：不可恢复（WebGL 缺失/上下文丢失/引擎建不起来），收面板回列表。 */
function markUnavailable(win: Window, state: DashState, reason: string): void {
  const viz = state.viz;
  if (!viz || viz.unavailable) return;
  viz.unavailable = true;
  viz.unavailableReason = reason;
  disposeEngine(viz);
  byId(win, "rp-dash-viz-viewport")?.replaceChildren();
  byId(win, "rp-dash-viz-loading")?.setAttribute("hidden", "hidden");
  const spatialButton = byId(win, "rp-dash-view-spatial");
  if (spatialButton) {
    spatialButton.setAttribute("disabled", "disabled");
    spatialButton.setAttribute("title", reason);
  }
  void appendPluginLog(`[dashboard-viz] unavailable: ${reason}`);
  viz.onExitToList?.();
}

/** 关窗收尾：引擎 dispose + 悬浮层清空（窗口即将销毁，状态随 WeakMap 回收）。 */
export function disposeViz(win: Window, state: DashState): void {
  const viz = state.viz;
  if (!viz) return;
  disposeEngine(viz);
  if (viz.overlay) {
    viz.overlay.overlay.textContent = "";
    viz.overlay = null;
  }
  viz.overlaySignature = "";
  byId(win, "rp-dash-viz-viewport")?.replaceChildren();
}

function disposeEngine(viz: VizState): void {
  try {
    viz.engine?.dispose();
  } catch {
    // 上下文已死时 dispose 可能抛错，忽略
  }
  viz.engine = null;
}

function prefersReducedMotion(win: Window): boolean {
  try {
    return win.matchMedia("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

function snapshotPercentOf(job: any): number | null {
  const progress = job?.stage_snapshot?.progress;
  const percent = Number(progress?.percent);
  if (Number.isFinite(percent)) return Math.max(0, Math.min(100, percent));
  const current = Number(progress?.current);
  const total = Number(progress?.total);
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(100, (current / total) * 100));
  }
  return null;
}

/** 悬浮层一次性骨架：常驻的工具条与机位坞；内容分区由 renderOverlay 填。 */
function buildOverlay(win: Window, viz: VizState): void {
  const overlay = byId(win, "rp-dash-viz-overlay");
  if (!overlay || viz.overlay) return;
  overlay.textContent = "";
  const summary = el(win, "div", "rp-viz-summary");
  const rail = el(win, "ol", "rp-viz-rail");
  rail.setAttribute("aria-label", getString("dashboard-viz-rail-label"));

  const toolbar = el(win, "div", "rp-viz-toolbar");
  toolbar.appendChild(
    toolButton(
      win,
      "dashboard-viz-tool-rotate",
      "dashboard-viz-tool-rotate-tip",
      "rotate",
      () => {
        viz.autoRotate = !viz.autoRotate;
        viz.engine?.setAutoRotate(viz.autoRotate);
        syncPressed(viz);
      },
    ),
  );
  toolbar.appendChild(
    toolButton(
      win,
      "dashboard-viz-tool-reset",
      "dashboard-viz-tool-reset-tip",
      null,
      () => applyCamera(win, viz, 0),
    ),
  );
  toolbar.appendChild(
    toolButton(
      win,
      "dashboard-viz-tool-zoom-out",
      "dashboard-viz-tool-zoom-out-tip",
      null,
      () => viz.engine?.zoomBy(-1),
    ),
  );
  toolbar.appendChild(
    toolButton(
      win,
      "dashboard-viz-tool-zoom-in",
      "dashboard-viz-tool-zoom-in-tip",
      null,
      () => viz.engine?.zoomBy(1),
    ),
  );
  toolbar.appendChild(
    toolButton(
      win,
      "dashboard-viz-tool-pause",
      "dashboard-viz-tool-pause-tip",
      "pause",
      () => {
        viz.animationPaused = !viz.animationPaused;
        viz.engine?.setAnimationPaused(viz.animationPaused);
        syncPressed(viz);
      },
      () =>
        getString(
          viz.animationPaused
            ? "dashboard-viz-tool-resume"
            : "dashboard-viz-tool-pause",
        ),
    ),
  );

  const dock = el(win, "nav", "rp-viz-camera-dock");
  dock.setAttribute("aria-label", getString("dashboard-viz-camera-label"));
  for (let index = 0; index < viz.cameraCount; index += 1) {
    const label =
      index === 0
        ? getString("dashboard-viz-cam-overview")
        : stationLabel(PIPELINE_STATION_KEYS[index - 1]);
    const button = el(win, "button", "rp-viz-camera-button", label);
    button.setAttribute("type", "button");
    button.dataset.camera = `${index}`;
    dock.appendChild(button);
  }

  const hint = byId(win, "rp-dash-viz-hint");
  if (hint) hint.textContent = getString("dashboard-viz-hint");
  overlay.append(summary, rail, toolbar, dock);
  viz.overlay = {
    overlay,
    summary,
    rail,
    queue: null,
    activity: null,
    toolbar,
    dock,
  };
  syncPressed(viz);
}

function toolButton(
  win: Window,
  labelKey: FtlKey,
  tipKey: FtlKey,
  /** 需要按压态语义的工具有自转与暂停；null = 普通按钮。 */
  pressedTool: "rotate" | "pause" | null,
  onClick: () => void,
  labelOf?: () => string,
): HTMLElement {
  const button = el(win, "button", "rp-viz-tool-button");
  button.setAttribute("type", "button");
  button.setAttribute("title", getString(tipKey));
  if (pressedTool) button.dataset.pressedTool = pressedTool;
  const refresh = () => {
    button.textContent = labelOf ? labelOf() : getString(labelKey);
  };
  refresh();
  button.addEventListener("click", () => {
    onClick();
    refresh();
  });
  return button;
}

/**
 * 面板级键盘（1-6 机位/A 自转/R 复位/空格暂停/±缩放）与画布点击拾取。
 * 监听挂面板容器（画布与悬浮层都在其内，事件自然冒泡）；只挂一次。
 */
function wirePanelEvents(win: Window, state: DashState, viz: VizState): void {
  const panel = byId(win, "rp-dash-viz");
  const overlay = byId(win, "rp-dash-viz-overlay");
  if (!panel || !overlay || viz.eventsWired) return;
  viz.eventsWired = true;
  panel.setAttribute("tabindex", "0");
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", getString("dashboard-viz-aria"));

  panel.addEventListener("keydown", (event) => {
    const keyEvent = event as KeyboardEvent;
    const target = keyEvent.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    const key = keyEvent.key;
    if (key >= "1" && key <= "9") {
      const index = Number(key) - 1;
      if (index < viz.cameraCount) applyCamera(win, viz, index);
    } else if (key === "a" || key === "A") {
      viz.autoRotate = !viz.autoRotate;
      viz.engine?.setAutoRotate(viz.autoRotate);
      syncPressed(viz);
    } else if (key === "r" || key === "R") {
      applyCamera(win, viz, 0);
    } else if (key === " ") {
      keyEvent.preventDefault();
      viz.animationPaused = !viz.animationPaused;
      viz.engine?.setAnimationPaused(viz.animationPaused);
      syncPressed(viz);
    } else if (key === "+" || key === "=") {
      viz.engine?.zoomBy(1);
    } else if (key === "-" || key === "_") {
      viz.engine?.zoomBy(-1);
    }
  });

  let pointerDown: { x: number; y: number } | null = null;
  panel.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    pointerDown = { x: pointerEvent.clientX, y: pointerEvent.clientY };
  });
  panel.addEventListener("pointerup", (event) => {
    const pointerEvent = event as PointerEvent;
    const down = pointerDown;
    pointerDown = null;
    if (!down) return;
    if (
      Math.abs(pointerEvent.clientX - down.x) > 5 ||
      Math.abs(pointerEvent.clientY - down.y) > 5
    )
      return;
    const station = viz.engine?.pickStation(
      pointerEvent.clientX,
      pointerEvent.clientY,
    );
    if (typeof station === "number" && station >= 0) {
      applyCamera(win, viz, station + 1);
    }
  });

  // 机位坞与队列的点击委托（队列项 = 切换聚焦任务）。
  overlay.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const cameraButton = target?.closest?.(
      "[data-camera]",
    ) as HTMLElement | null;
    if (cameraButton?.dataset.camera) {
      applyCamera(win, viz, Number(cameraButton.dataset.camera));
      return;
    }
    const queueButton = target?.closest?.(
      "[data-focus-job]",
    ) as HTMLElement | null;
    const jobId = queueButton?.dataset.focusJob;
    if (jobId) {
      viz.focusJobId = jobId;
      viz.jobDetail = null;
      viz.overlaySignature = "";
      updateViz(win, state);
      refreshVizFocusDetail(win, state);
    }
  });
}

function applyCamera(win: Window, viz: VizState, index: number): void {
  const next = Math.max(0, Math.min(index, viz.cameraCount - 1));
  viz.cameraIndex = next;
  viz.autoRotate = false;
  viz.engine?.setAutoRotate(false);
  viz.engine?.setCamera(next);
  syncPressed(viz);
}

/** 工具条按压态（自转/暂停）与机位坞选中态的视觉同步。 */
function syncPressed(viz: VizState): void {
  const overlay = viz.overlay?.overlay;
  if (!overlay) return;
  overlay.querySelectorAll(".rp-viz-camera-button").forEach((node: Element) => {
    const button = node as HTMLButtonElement;
    button.setAttribute(
      "aria-pressed",
      Number(button.dataset.camera) === viz.cameraIndex ? "true" : "false",
    );
  });
  overlay.querySelectorAll(".rp-viz-tool-button").forEach((node: Element) => {
    const button = node as HTMLButtonElement;
    const tool = button.dataset.pressedTool;
    if (tool === "rotate") {
      button.setAttribute("aria-pressed", viz.autoRotate ? "true" : "false");
    } else if (tool === "pause") {
      button.setAttribute(
        "aria-pressed",
        viz.animationPaused ? "true" : "false",
      );
    }
  });
}

/**
 * 悬浮层内容重建（签名防抖）：摘要/五站轨道/等待队列/最近活动。工具条与
 * 机位坞是常驻节点，重建只搬动它们的位置维持 summary→rail→queue→activity
 * →toolbar→dock 的视觉顺序（对应网页端悬浮层的排布）。
 */
function renderOverlay(
  win: Window,
  viz: VizState,
  model: PipelineSceneModel,
  focusedTitle: string,
): void {
  const refs = viz.overlay;
  if (!refs) return;
  const percent = Math.round(model.overall * 100);
  const signature = JSON.stringify([
    focusedTitle,
    model.headline.kind,
    model.headline.kind === "detail" ? model.headline.text : "",
    percent,
    model.stations.map((station) => [
      station.phase,
      station.progressText,
      station.detail,
    ]),
    model.queue.map((item) => [item.jobId, item.title, item.pageCount]),
    model.activity.map((item) => [item.title, item.liveDetail, item.status]),
    viz.focusJobId,
  ]);
  if (signature === viz.overlaySignature) return;
  viz.overlaySignature = signature;

  // 摘要卡：聚焦任务 → 一句话 + 总进度。
  refs.summary.textContent = "";
  const jobLine = el(win, "p", "rp-viz-job", focusedTitle);
  jobLine.setAttribute("title", focusedTitle);
  refs.summary.appendChild(jobLine);
  const head = el(win, "div", "rp-viz-summary-head");
  head.appendChild(
    el(
      win,
      "strong",
      "rp-viz-headline",
      headlineText(
        model.headline.kind,
        model.headline.kind === "detail" ? model.headline.text : "",
      ),
    ),
  );
  head.appendChild(el(win, "span", "rp-viz-percent", `${percent}%`));
  refs.summary.appendChild(head);
  const track = el(win, "div", "rp-viz-progress-track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuenow", `${percent}`);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-label", getString("dashboard-viz-progress-label"));
  const bar = el(win, "span", "rp-viz-progress-bar");
  bar.style.transform = `scaleX(${model.overall})`;
  track.appendChild(bar);
  refs.summary.appendChild(track);

  // 五站轨道。
  refs.rail.textContent = "";
  const phaseText: Record<string, string> = {
    idle: getString("dashboard-viz-phase-idle"),
    active: getString("dashboard-viz-phase-active"),
    done: getString("dashboard-viz-phase-done"),
    failed: getString("dashboard-viz-phase-failed"),
  };
  for (const station of model.stations) {
    const step = el(win, "li", "rp-viz-rail-step");
    step.dataset.phase = station.phase;
    step.appendChild(el(win, "span", "rp-viz-rail-state"));
    step.appendChild(
      el(win, "span", "rp-viz-rail-label", stationLabel(station.key)),
    );
    const detail =
      station.detail || station.progressText || phaseText[station.phase] || "";
    step.appendChild(el(win, "span", "rp-viz-rail-detail", detail));
    refs.rail.appendChild(step);
  }

  // 等待队列（封顶 8 份，多出的 +N；点击切换聚焦）。
  refs.queue?.remove();
  refs.queue = null;
  if (model.queue.length > 0) {
    const queue = el(win, "div", "rp-viz-queue");
    const caption = getString("dashboard-viz-queue-caption", {
      args: { count: model.queue.length },
    });
    queue.setAttribute("aria-label", caption);
    queue.appendChild(el(win, "span", "rp-viz-queue-caption", caption));
    const list = el(win, "ul", "rp-viz-queue-list");
    for (const item of model.queue.slice(0, QUEUE_DISPLAY_LIMIT)) {
      const row = el(win, "li");
      const button = el(win, "button", "rp-viz-queue-item");
      button.setAttribute("type", "button");
      button.dataset.focusJob = item.jobId;
      const title = item.title || getString("dashboard-unnamed");
      const titleNode = el(win, "span", "rp-viz-queue-title", title);
      titleNode.setAttribute("title", title);
      button.appendChild(titleNode);
      if (item.pageCount) {
        button.appendChild(
          el(
            win,
            "span",
            "rp-viz-queue-pages",
            getString("dashboard-viz-queue-pages", {
              args: { count: item.pageCount },
            }),
          ),
        );
      }
      row.appendChild(button);
      list.appendChild(row);
    }
    const hidden = model.queue.length - QUEUE_DISPLAY_LIMIT;
    if (hidden > 0) {
      list.appendChild(
        el(
          win,
          "li",
          "rp-viz-queue-more",
          getString("dashboard-viz-queue-more", { args: { count: hidden } }),
        ),
      );
    }
    queue.appendChild(list);
    refs.queue = queue;
  }

  // 最近活动（封顶 4 行）。
  refs.activity?.remove();
  refs.activity = null;
  const activity = model.activity.slice(0, 4);
  if (activity.length > 0) {
    const card = el(win, "div", "rp-viz-activity");
    card.setAttribute(
      "aria-label",
      getString("dashboard-viz-activity-caption"),
    );
    card.appendChild(
      el(
        win,
        "span",
        "rp-viz-activity-caption",
        getString("dashboard-viz-activity-caption"),
      ),
    );
    const list = el(win, "ul", "rp-viz-activity-list");
    for (const item of activity) {
      const text = item.liveDetail
        ? item.liveDetail
        : `${item.title || getString("dashboard-unnamed")} · ${activityStatusText(item.status)}`;
      list.appendChild(el(win, "li", "rp-viz-activity-item", text));
    }
    card.appendChild(list);
    refs.activity = card;
  }

  // 常驻节点搬回队尾，维持固定视觉顺序。
  refs.overlay.append(
    refs.summary,
    refs.rail,
    ...(refs.queue ? [refs.queue] : []),
    ...(refs.activity ? [refs.activity] : []),
    refs.toolbar,
    refs.dock,
  );
}

/** 内容栏切换控件的按压态与禁用态同步（宿主在视图切换/降级时调用）。 */
export function renderViewToggle(win: Window, state: DashState): void {
  for (const view of ["list", "spatial"] as const) {
    const button = byId(win, `rp-dash-view-${view}`);
    if (button) {
      button.setAttribute(
        "aria-pressed",
        (state.vizActive ? "spatial" : "list") === view ? "true" : "false",
      );
    }
  }
}
