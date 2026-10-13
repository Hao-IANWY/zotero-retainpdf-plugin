import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobListItemView } from "@retainpdf/contracts/job-status";
import {
  Activity,
  CheckCircle2,
  Clock3,
  Eraser,
  FileText,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useTaskCenterAutoRefresh } from "./use-task-center-discovery.js";
import { useTaskLiveProgress } from "./use-task-live-progress.js";
import { API_PREFIX } from "@/platform/config/api-constants.js";
import { formatZhDateTime } from "@/platform/utils/datetime.js";
import {
  groupTaskCenterJobs,
  taskCenterCounts,
  taskDocumentLabel,
  taskIdentity,
  taskProgressPercent,
  taskStatusLabel,
  taskWorkflowLabel,
  type TaskCenterGroupKey,
} from "../domain/model.js";
import {
  deleteTaskCenterHistory,
  loadTaskCenterJobs,
  mergeTaskCenterJobs,
  TASK_CENTER_MAX_ITEMS,
} from "../domain/task-center-api.js";

// 展示策略：任务中心只读——不提供取消/重试等任何任务操作，干预一律走
// Zotero 插件或 API 客户端；页面自己只保留加载与查看。

const ACTIVE_STATUSES = new Set(["queued", "running"]);

const GROUP_ICONS = {
  running: Activity,
  queued: Clock3,
  failed: TriangleAlert,
  completed: CheckCircle2,
} satisfies Record<TaskCenterGroupKey, typeof Activity>;

function shortJobId(jobId: string): string {
  const value = `${jobId || ""}`.trim();
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
}

/** 相对时间(分钟粒度)。绝对时间戳每秒心跳都在变,驱动重渲染就是列表抖动源。 */
function relativeUpdatedAt(value: string): string {
  const date = new Date(value).getTime();
  if (!Number.isFinite(date)) return "";
  const diffMs = Date.now() - date;
  if (diffMs < 60_000) return "刚刚";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  return formatZhDateTime(new Date(value));
}

/** TaskRow 等价比较:只看视觉字段。updated_at 秒级心跳与 stage 细节被挡掉,
 * 1s 轮询下无视觉变化就零重渲染(这是列表抖动的根治)。 */
function taskRowEquals(a: TaskRowProps, b: TaskRowProps): boolean {
  const [ja, jb] = [a.job, b.job];
  const minute = (v?: string) => Math.floor(new Date(v || 0).getTime() / 60_000);
  return ja.job_id === jb.job_id && ja.status === jb.status
    && ja.display_name === jb.display_name && ja.source_file_name === jb.source_file_name
    && ja.workflow === jb.workflow && taskProgressPercent(ja) === taskProgressPercent(jb)
    && minute(ja.updated_at) === minute(jb.updated_at)
    && Math.round(a.live?.percent ?? -1) === Math.round(b.live?.percent ?? -1)
    && a.live?.stageDetail === b.live?.stageDetail;
}

type TaskRowProps = {
  job: JobListItemView;
  onOpen: (job: JobListItemView) => void;
  /** SSE 行级实时进度;活跃卡片优先于列表摘要快照 */
  live?: { percent?: number; stageDetail?: string };
};

const TaskRow = memo(function TaskRow({ job, live, onOpen }: TaskRowProps) {
  const status = `${job.status || ""}`.trim().toLowerCase();
  const isActive = ACTIVE_STATUSES.has(status);
  const progress = isActive && live?.percent != null ? live.percent : taskProgressPercent(job);

  return (
    <article
      className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 shadow-sm transition-shadow hover:shadow-md"
      data-task-id={taskIdentity(job)}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
          <FileText className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">文档</span>
            <h3 className="min-w-0 truncate text-sm font-semibold text-foreground" title={taskDocumentLabel(job)}>
              {taskDocumentLabel(job)}
            </h3>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>任务 <code title={job.job_id}>{shortJobId(job.job_id)}</code></span>
            <span>{taskWorkflowLabel(job)}</span>
            {job.updated_at ? <span>{relativeUpdatedAt(job.updated_at)}</span> : null}
          </div>
          {isActive && progress !== null ? (
            <div className="mt-2 flex items-center gap-2" aria-label={`任务进度 ${Math.round(progress)}%`}>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${progress}%` }} />
              </div>
              <span className="w-9 text-right text-[11px] text-muted-foreground">{Math.round(progress)}%</span>
            </div>
          ) : null}
        </div>
        <span className="shrink-0 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground">
          {taskStatusLabel(job)}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-end border-t border-border/60 pt-3">
        <button
          type="button"
          className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
          onClick={() => onOpen(job)}
        >
          打开详情
        </button>
      </div>
    </article>
  );
}, taskRowEquals);

export type TaskCenterOpenBookDetailInput = {
  job_id?: string;
  display_name?: string;
  source_file_name?: string;
  workflow?: string;
  [key: string]: unknown;
};

export type TaskCenterProps = {
  /** 点任务卡片打开书籍详情：由页面接到自己的图书馆动作上。 */
  onOpenBookDetail: (input: TaskCenterOpenBookDetailInput) => void;
};

export function TaskCenter({ onOpenBookDetail }: TaskCenterProps) {
  const [items, setItems] = useState<JobListItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [reachedLimit, setReachedLimit] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const mountedRef = useRef(true);
  const requestInFlightRef = useRef(false);

  const itemsRef = useRef<JobListItemView[]>([]);
  const nextOffsetRef = useRef(0);
  const generationRef = useRef(0);
  const [clearingGroup, setClearingGroup] = useState<TaskCenterGroupKey | null>(null);

  const load = useCallback(async ({ append = false }: { append?: boolean } = {}) => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setRefreshing(true);
    generationRef.current += 1;
    try {
      const result = await loadTaskCenterJobs(undefined, { offset: append ? nextOffsetRef.current : 0 });
      if (!mountedRef.current) return;
      const next = append ? mergeTaskCenterJobs(itemsRef.current, result.items) : result.items;
      itemsRef.current = next;
      nextOffsetRef.current = result.nextOffset;
      setItems(next);
      setHasMore(result.hasMore);
      setReachedLimit(Boolean(result?.reachedLimit));
      setError("");
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(cause instanceof Error ? cause.message : "读取任务失败，请稍后重试。");
    } finally {
      requestInFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);


  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => { mountedRef.current = false; generationRef.current += 1; };
  }, [load]);

  const activeJobIds = useMemo(
    () => items
      .filter((job) => ACTIVE_STATUSES.has(`${job.status || ""}`.toLowerCase()))
      .map((job) => job.job_id),
    [items],
  );
  const liveProgress = useTaskLiveProgress(activeJobIds, API_PREFIX, () => { void load(); });

  useTaskCenterAutoRefresh({
    itemsRef, nextOffsetRef, generationRef, mountedRef, setItems,
    listInFlightRef: requestInFlightRef });

  const groups = useMemo(() => groupTaskCenterJobs(items), [items]);
  const counts = useMemo(() => taskCenterCounts(items), [items]);

  // 清空一个终态分组:逐个真删后端任务(-ocr 子任务随父级联),完成后
  // 重新拉列表让界面回到服务端真相;失败的任务会留在刷新后的列表里。
  async function handleClearGroup(groupKey: TaskCenterGroupKey) {
    const group = groups.find((entry) => entry.key === groupKey);
    if (!group?.items.length || clearingGroup) return;
    setClearingGroup(groupKey);
    try {
      const { failed } = await deleteTaskCenterHistory(group.items);
      if (failed > 0) {
        setError(`清空完成，${failed} 条任务删除失败（多为运行中或已不可删），已保留在列表。`);
      }
      await load();
    } finally {
      if (mountedRef.current) setClearingGroup(null);
    }
  }

  function handleOpen(job: JobListItemView) {
    // Book detail consumes the library projection, while /jobs returns a task
    // projection. Only bridge fields present in both contracts; notably do not
    // manufacture a document_id for a job list row.
    onOpenBookDetail({
      job_id: job.job_id,
      display_name: job.display_name,
      source_file_name: job.source_file_name || undefined,
      workflow: job.workflow,
      status: job.status,
      page_count: job.page_count,
      cover_url: job.cover_url || undefined,
      thumbnail_url: job.thumbnail_url || undefined,
      created_at: job.created_at,
      updated_at: job.updated_at,
      prefer_translate_tab: true,
    });
  }

  return (
    <section id="task-center-view" className="mx-auto flex h-full w-full max-w-6xl flex-col px-5 pb-28 pt-5" aria-label="任务中心">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">任务中心</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">PDF 处理任务</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {reachedLimit
              ? `当前已加载最近 ${TASK_CENTER_MAX_ITEMS} 条，达到前端安全上限。`
              : `当前加载 ${items.length} 条${hasMore ? "，可继续加载更多" : ""}；每次处理按独立任务展示。`}
          </p>
        </div>
        <button
          id="task-center-refresh-btn"
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm hover:bg-muted disabled:opacity-50"
          disabled={refreshing}
          onClick={() => void load()}
        >
          <RefreshCw className={`size-4${refreshing ? " animate-spin" : ""}`} />
          刷新
        </button>
      </header>

      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="当前加载范围任务计数">
        {([
          ["全部", counts.total],
          ["运行中", counts.running],
          ["排队中", counts.queued],
          ["失败", counts.failed],
          ["已完成", counts.completed],
        ] as const).map(([label, count]) => (
          <div key={label} className="rounded-xl border border-border/70 bg-background/70 px-3 py-2.5">
            <div className="text-lg font-semibold text-foreground">{count}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" /> 正在读取任务…
        </div>
      ) : error && items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <TriangleAlert className="size-7 text-muted-foreground" />
          <p className="text-sm text-foreground">{error}</p>
          <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={() => void load()}>重新加载</button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <Clock3 className="size-7 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">暂无处理任务</p>
          <p className="text-xs text-muted-foreground">上传 PDF 并执行 OCR 或翻译后，任务会出现在这里。</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {error ? <div className="mb-3 rounded-xl border border-border bg-background px-3 py-2 text-xs text-muted-foreground">刷新失败：{error}</div> : null}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {groups.map((group) => {
              const Icon = GROUP_ICONS[group.key];
              // 只有终态组可清空历史;运行/排队组是进行中的事实,不该被隐藏
              const clearable = group.key === "failed" || group.key === "completed";
              return (
                <section key={group.key} className="rounded-3xl border border-border/70 bg-muted/35 p-3" aria-labelledby={`task-group-${group.key}`}>
                  <header className="flex items-center justify-between px-1 pb-3">
                    <div className="flex items-center gap-2">
                      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                      <h2 id={`task-group-${group.key}`} className="text-sm font-semibold text-foreground">{group.label}</h2>
                    </div>
                    <div className="flex items-center gap-2">
                      {clearable && group.items.length > 0 ? (
                        <button
                          type="button"
                          className="inline-flex h-6 items-center gap-1 rounded-md border border-transparent px-2 text-[11px] text-muted-foreground hover:border-border hover:bg-background hover:text-foreground disabled:opacity-50"
                          disabled={clearingGroup !== null}
                          onClick={() => void handleClearGroup(group.key)}
                          title="删除本组全部任务的记录与产物文件（源 PDF 保留）"
                        >
                          {clearingGroup === group.key ? (
                            <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                          ) : (
                            <Eraser className="size-3" aria-hidden="true" />
                          )}
                          {clearingGroup === group.key ? "清空中…" : "清空"}
                        </button>
                      ) : null}
                      <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">{group.items.length}</span>
                    </div>
                  </header>
                  {group.items.length ? (
                    <div className="space-y-2">
                      {group.items.map((job) => (
                        <TaskRow
                          key={taskIdentity(job)}
                          job={job}
                          live={liveProgress[job.job_id]}
                          onOpen={handleOpen}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">暂无{group.label}任务</div>
                  )}
                </section>
              );
            })}
          </div>
          {hasMore ? (
            <div className="flex justify-center py-4">
              <button type="button" className="rounded-xl border border-border px-4 py-2 text-sm disabled:opacity-50"
                disabled={refreshing} onClick={() => void load({ append: true })}>
                {refreshing ? "加载中…" : "加载更多任务"}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
