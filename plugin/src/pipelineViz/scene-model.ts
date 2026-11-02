// 三维流水线的场景模型：从网页端 features/pipeline-viz/domain/scene-model.ts
// 移植（同一作者仓库间搬运）。把任务快照派生成五台设备的状态——纯函数、
// 不依赖 three，主 bundle 直接可用；引擎只认 sceneModelToEngineInput 的输出。
//
// 与网页版的差异：展示文案（站名/一句话/活动行）不在这里拼中文，模型只给
// 结构化字段（key/status/kind），渲染层（dashboardViz）经 FTL 出双语——
// 中控台是插件，en-US 是一等公民。
//
// 五站与公共四阶段（ocr→translate→render→done）的对应是派生的：
// 「文档准备」覆盖排队/上传期（display_stage 为空的 queued/running），
// 「完成输出」覆盖终态——后端没有这两个 display_stage，也不为此改契约。

/** 五站的固定顺序；站名文案由渲染层按 key 查 FTL。 */
export const PIPELINE_STATION_KEYS = Object.freeze([
  "prepare",
  "ocr",
  "translate",
  "render",
  "output",
] as const);

export type PipelineStationKey = (typeof PIPELINE_STATION_KEYS)[number];

export type PipelineStationPhase = "idle" | "active" | "done" | "failed";

export type PipelineStationState = {
  key: PipelineStationKey;
  phase: PipelineStationPhase;
  /** 0..1；idle 或未知为 null。 */
  progress: number | null;
  /** 「current / total」原文（无单位词），空串表示没有。 */
  progressText: string;
  /** 实时阶段说明（stage_detail），仅活跃站有。 */
  detail: string;
};

/** 活动行：标题 + 原始 status，文案由渲染层出。 */
export type PipelineActivityItem = {
  ts: string;
  /** 实时说明行（SSE stage_detail）置顶时 title 为空、liveDetail 有值。 */
  title: string;
  liveDetail: string;
  status: string;
};

export type PipelineQueueItem = {
  jobId: string;
  title: string;
  pageCount: number | null;
};

/** 顶部一句话的结构化形态：kind 决定 FTL 键，detail 是 stage_detail 原文。 */
export type PipelineHeadlineKind =
  | "detail"
  | "succeeded"
  | "failed"
  | "canceled"
  | "queued"
  | "running"
  | "waiting";

export type PipelineHeadline =
  | { kind: "detail"; text: string }
  | { kind: "succeeded" }
  | { kind: "failed" }
  | { kind: "canceled" }
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "waiting" };

export type PipelineSceneModel = {
  stations: PipelineStationState[];
  /** 0..1；优先统一百分比（快照+SSE 合成），缺省按站点估算。 */
  overall: number;
  activity: PipelineActivityItem[];
  /** 站 0 进纸口前的等待队列（排队中的任务，队首语义上是最早入队的）。 */
  queue: PipelineQueueItem[];
  terminal: "none" | "succeeded" | "failed" | "canceled";
  headline: PipelineHeadline;
  reducedMotion: boolean;
};

/** 任务快照的可读子集：getJob 详情与 listJobs 列表项都兼容。 */
export type PipelineJobLike = {
  job_id?: string | null;
  id?: string | null;
  status?: string | null;
  display_name?: string | null;
  title?: string | null;
  page_count?: number | null;
  created_at?: string | null;
  stage_snapshot?: {
    display_stage?: string | null;
    stage?: string | null;
    substage?: string | null;
    stage_detail?: string | null;
    progress?: {
      current?: number | null;
      total?: number | null;
      percent?: number | null;
      unit?: string | null;
    } | null;
  } | null;
  failure?: { stage?: string | null; summary?: string | null } | null;
} | null;

export type BuildPipelineSceneModelInput = {
  /** 聚焦任务：列表项或（更准的）getJob 详情，见 dashboardViz 的取数纪律。 */
  job: PipelineJobLike;
  /** 单独的 OCR 子任务：翻译死在 OCR 段时，失败归属以它为准（更具体）。 */
  ocrJob?: PipelineJobLike;
  /** 同列表全部任务：派生等待队列与活动列表；缺省只看当前任务。 */
  jobs?: PipelineJobLike[] | null;
  /** 统一百分比（0..100 或 null）：SSE 实时优先，快照兜底。 */
  overallPercent?: number | null;
  /** 实时阶段说明（SSE stage_detail 去页数）。 */
  liveDetail?: string;
  reducedMotion?: boolean;
};

/** display_stage → 站下标；ocr/translation/render 是仅有的三个公共阶段。 */
function stationIndexOf(
  displayStage: string | null | undefined,
  status: string,
): number {
  const display = `${displayStage || ""}`.trim().toLowerCase();
  if (display === "ocr") return 1;
  if (display === "translation" || display === "translate") return 2;
  if (display === "render") return 3;
  // 没有公共阶段的 running/queued 是排队或上传期——站 0；终态由调用方另行处理。
  return status === "running" || status === "queued" ? 0 : -1;
}

function normalizeStatus(status: string | null | undefined): string {
  return `${status || ""}`.trim().toLowerCase();
}

function progressRatio(
  progress:
    | {
        current?: number | null;
        total?: number | null;
        percent?: number | null;
      }
    | null
    | undefined,
): number | null {
  if (!progress) return null;
  if (
    typeof progress.percent === "number" &&
    Number.isFinite(progress.percent)
  ) {
    return Math.min(1, Math.max(0, progress.percent / 100));
  }
  const current = progress.current;
  const total = progress.total;
  if (
    typeof current === "number" &&
    typeof total === "number" &&
    total > 0 &&
    current >= 0
  ) {
    return Math.min(1, current / total);
  }
  return null;
}

function progressTextOf(
  progress:
    | {
        current?: number | null;
        total?: number | null;
        unit?: string | null;
      }
    | null
    | undefined,
): string {
  if (!progress) return "";
  const current = progress.current;
  const total = progress.total;
  if (typeof current === "number" && typeof total === "number" && total > 0) {
    return `${current} / ${total}`;
  }
  return "";
}

/** 失败落在哪一站：以 display_stage 优先，OCR 子任务的 failure.stage 兜底；
 *  都没有（排队/上传期就死了）归站 0。 */
function failedStationIndex(
  job: PipelineJobLike,
  ocrJob?: PipelineJobLike,
): number {
  const display = `${job?.stage_snapshot?.display_stage || ""}`
    .trim()
    .toLowerCase();
  if (display === "ocr") return 1;
  if (display === "translation" || display === "translate") return 2;
  if (display === "render") return 3;
  const failureStage = `${ocrJob?.failure?.stage || job?.failure?.stage || ""}`
    .trim()
    .toLowerCase();
  if (failureStage === "ocr") return 1;
  if (failureStage === "translation" || failureStage === "translate") return 2;
  if (failureStage === "render") return 3;
  return 0;
}

/** 等待队列：排队中的任务（不含当前任务），按入队先后排。 */
export function buildQueue(
  jobs: PipelineJobLike[] | null | undefined,
  currentJobId: string,
): PipelineQueueItem[] {
  const list = Array.isArray(jobs) ? jobs : [];
  const queued = list.filter((item) => {
    const id = `${item?.job_id || item?.id || ""}`.trim();
    return (
      Boolean(id) &&
      id !== currentJobId &&
      normalizeStatus(item?.status) === "queued"
    );
  });
  return queued
    .map((item) => ({
      jobId: `${item?.job_id || item?.id || ""}`.trim(),
      title: `${item?.display_name || item?.title || ""}`.trim(),
      pageCount: typeof item?.page_count === "number" ? item.page_count : null,
      createdAt: `${item?.created_at || ""}`,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ jobId, title, pageCount }) => ({ jobId, title, pageCount }));
}

const ACTIVITY_LIMIT = 6;

/** 活动列表（任务级）：实时说明置顶，其余按创建时间倒序的各任务一行。 */
function buildActivity(
  input: BuildPipelineSceneModelInput,
  status: string,
  activeIndex: number,
): PipelineActivityItem[] {
  const items: PipelineActivityItem[] = [];
  const live = `${input.liveDetail || ""}`.trim();
  if (live && (status === "running" || status === "queued")) {
    items.push({ ts: "", title: "", liveDetail: live, status: "running" });
  }
  const list = Array.isArray(input.jobs)
    ? input.jobs
    : input.job
      ? [input.job]
      : [];
  const history = list
    .filter((item) => `${item?.job_id || item?.id || ""}`.trim())
    .map((item) => ({
      ts: `${item?.created_at || ""}`,
      title: `${item?.display_name || item?.title || ""}`.trim(),
      liveDetail: "",
      status: normalizeStatus(item?.status),
    }))
    .sort((a, b) => b.ts.localeCompare(a.ts));
  items.push(...history.slice(0, ACTIVITY_LIMIT));
  if (activeIndex >= 0 && items.length === 0) {
    items.push({ ts: "", title: "", liveDetail: "", status: "waiting" });
  }
  return items;
}

function headlineOf(
  status: string,
  detail: string,
  terminal: PipelineSceneModel["terminal"],
): PipelineHeadline {
  if (detail) return { kind: "detail", text: detail };
  if (terminal === "succeeded") return { kind: "succeeded" };
  if (terminal === "failed") return { kind: "failed" };
  if (terminal === "canceled") return { kind: "canceled" };
  if (status === "queued") return { kind: "queued" };
  if (status === "running") return { kind: "running" };
  return { kind: "waiting" };
}

export function buildPipelineSceneModel(
  input: BuildPipelineSceneModelInput,
): PipelineSceneModel {
  const job = input.job ?? null;
  const status = normalizeStatus(job?.status);
  const terminal: PipelineSceneModel["terminal"] =
    status === "succeeded"
      ? "succeeded"
      : status === "failed"
        ? "failed"
        : status === "canceled" || status === "cancelled"
          ? "canceled"
          : "none";

  const activeIndex = stationIndexOf(
    job?.stage_snapshot?.display_stage,
    status,
  );
  const failedIndex =
    terminal === "failed" ? failedStationIndex(job, input.ocrJob) : -1;
  // 各站的「已走到」边界：终态成功全站完成；失败/取消时只完成失败点之前的站。
  const frontier =
    terminal === "succeeded"
      ? PIPELINE_STATION_KEYS.length
      : failedIndex >= 0
        ? failedIndex
        : activeIndex;

  const liveProgress = progressRatio(job?.stage_snapshot?.progress);
  const liveProgressText = progressTextOf(job?.stage_snapshot?.progress);
  const detail = `${job?.stage_snapshot?.stage_detail || ""}`.trim();

  const stations: PipelineStationState[] = PIPELINE_STATION_KEYS.map(
    (key, index) => {
      let phase: PipelineStationPhase = "idle";
      if (terminal === "succeeded") {
        phase = "done";
      } else if (index === failedIndex) {
        phase = "failed";
      } else if (index < frontier) {
        phase = "done";
      } else if (
        index === activeIndex &&
        (status === "running" || status === "queued")
      ) {
        // 站 0 的排队期也算 active：进纸口有东西才不显得整条线是死的。
        phase = "active";
      }
      const progress =
        phase === "done"
          ? 1
          : phase === "active"
            ? index === 0
              ? null
              : liveProgress
            : null;
      return {
        key,
        phase,
        progress,
        progressText: phase === "active" && index !== 0 ? liveProgressText : "",
        detail: phase === "active" ? detail : "",
      };
    },
  );

  // 整体进度：优先统一口径（SSE 实时）；缺省按「已完成站数 + 当前站进度」
  // 估算，不外推时间——快照没动，数字就不动。
  const overallFromTab =
    typeof input.overallPercent === "number" &&
    Number.isFinite(input.overallPercent)
      ? Math.min(1, Math.max(0, input.overallPercent / 100))
      : null;
  const activeProgress = liveProgress ?? 0;
  const estimated = Math.min(
    1,
    (Math.max(0, frontier) + (activeIndex >= 0 ? activeProgress : 0)) /
      PIPELINE_STATION_KEYS.length,
  );
  const overall = overallFromTab ?? (terminal === "succeeded" ? 1 : estimated);

  const currentJobId = `${job?.job_id || job?.id || ""}`.trim();
  const queue = buildQueue(input.jobs, currentJobId);

  return {
    stations,
    overall,
    activity: buildActivity(input, status, activeIndex),
    queue,
    terminal,
    headline: headlineOf(status, detail, terminal),
    reducedMotion: Boolean(input.reducedMotion),
  };
}

/** 场景模型 → 引擎采样输入（快照驱动；引擎按「全站 done」采样完成态）。 */
export function sceneModelToEngineInput(model: PipelineSceneModel): {
  stageIndex: number;
  stageProgress: number;
  overall: number;
  complete: boolean;
  motion: number;
  failedIndex: number | null;
} {
  const activeIndex = model.stations.findIndex(
    (station) => station.phase === "active",
  );
  const failedIndex = model.stations.findIndex(
    (station) => station.phase === "failed",
  );
  const stageIndex =
    model.terminal === "succeeded" ? model.stations.length : activeIndex;
  return {
    stageIndex,
    stageProgress:
      activeIndex >= 0 ? (model.stations[activeIndex].progress ?? 0) : 0,
    overall: model.overall,
    complete: model.terminal === "succeeded",
    motion: model.reducedMotion ? 0 : 1,
    failedIndex: failedIndex >= 0 ? failedIndex : null,
  };
}
