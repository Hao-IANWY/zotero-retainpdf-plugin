import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { appendPluginLog } from "../utils/log";
import { RetainPdfClient } from "../api";

/**
 * 中控台页面逻辑(docs/ops/planning/zotero-native-dashboard.md)。
 * initDashboard 由开窗方在窗口 load 后调用:文案填充、导航栏、卡片列表、
 * 数据轮询(3s)与活跃任务 SSE 全部在这里装配;窗口 unload 时
 * destroyDashboard 收掉定时器与 SSE,不留悬挂。
 *
 * 布局(2026-10-14 老板钦定,GitHub 式):左侧导航切换分组过滤
 * (全部/运行中/排队中/失败/已完成,计数徽章在导航项上),内容区单栏
 * 卡片列表;清空历史按钮在内容区顶栏,仅失败/已完成视图可见。
 *
 * 消费纪律(与网页任务中心一致):主状态只读 status,进度只读
 * stage_snapshot.progress 与 SSE 事件;取消/重试等干预不做,清空历史
 * 是唯一写操作(DELETE library/books,-ocr 子任务行跳过)。
 * 渲染纪律:卡片按 job_id 复用,视觉字段签名未变则零重排——1s 心跳的
 * updated_at 被分钟粒度拍平,这是列表不抖的根因(同网页 TaskRow memo)。
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";
const LIST_LIMIT = 50;
const POLL_MS = 3000;

const GROUP_ORDER = ["running", "queued", "failed", "completed"] as const;
type GroupKey = (typeof GROUP_ORDER)[number];
type FilterKey = GroupKey | "all";

/** 导航项定义:顺序即侧边栏顺序(全部在最上,对齐 GitHub 过滤器习惯)。 */
type FtlKey = Parameters<typeof getString>[0];
const NAV_DEFS: Array<{ key: FilterKey; icon: string; labelKey: FtlKey }> = [
  { key: "all", icon: "rp-icon--list", labelKey: "dashboard-tile-all" },
  {
    key: "running",
    icon: "rp-icon--running",
    labelKey: "dashboard-group-running",
  },
  {
    key: "queued",
    icon: "rp-icon--queued",
    labelKey: "dashboard-group-queued",
  },
  {
    key: "failed",
    icon: "rp-icon--failed",
    labelKey: "dashboard-group-failed",
  },
  {
    key: "completed",
    icon: "rp-icon--succeeded",
    labelKey: "dashboard-group-completed",
  },
];

/** 网页端同纪律:只有终态组可清空;运行/排队是进行中的事实。 */
const CLEARABLE_FILTERS = new Set<FilterKey>(["failed", "completed"]);

interface LiveProgress {
  percent?: number;
  stageDetail?: string;
}

interface DashState {
  /** 代际号:每次请求 +1,回包比对防旧请求覆盖新状态/关窗后回写。 */
  generation: number;
  pollTimer: number | null;
  items: any[];
  /** 首屏加载完成前为 false(决定 loading 视图还是列表)。 */
  hasLoaded: boolean;
  error: string;
  filter: FilterKey;
  clearingGroup: GroupKey | null;
  live: Map<string, LiveProgress>;
  sseClosers: Map<string, () => void>;
  cards: Map<string, HTMLElement>;
  navCounts: Partial<Record<FilterKey, HTMLElement>>;
}

const states = new WeakMap<Window, DashState>();

const reason = (error: unknown) =>
  error instanceof Error && error.message ? error.message : String(error);

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

/** 窗口开着且代际未变才可回写,二者缺一即丢弃(关窗/新请求先行)。 */
function alive(win: Window, state: DashState, generation: number): boolean {
  return !win.closed && state.generation === generation && states.has(win);
}

/** 初始化:静态文案 + 导航 DOM + 事件 + 首轮加载与轮询。 */
export function initDashboard(win: Window): void {
  const state: DashState = {
    generation: 0,
    pollTimer: null,
    items: [],
    hasLoaded: false,
    error: "",
    filter: "all",
    clearingGroup: null,
    live: new Map(),
    sseClosers: new Map(),
    cards: new Map(),
    navCounts: {},
  };
  states.set(win, state);

  win.document.title = getString("dashboard-window-title");
  fillStaticText(win);
  buildNav(win, state);
  wireEvents(win, state);

  void loadJobs(win, state);
}

/** 收尾:轮询与 SSE 全收,状态解除引用。开窗方在 unload 时调用。 */
export function destroyDashboard(win: Window): void {
  const state = states.get(win);
  if (!state) return;
  state.generation += 1;
  try {
    if (state.pollTimer !== null) win.clearTimeout(state.pollTimer);
  } catch {
    // 窗口已在销毁途中,清不上也算收尾
  }
  for (const close of state.sseClosers.values()) {
    try {
      close();
    } catch {
      // EventSource 已死,忽略
    }
  }
  state.sseClosers.clear();
  states.delete(win);
}

function fillStaticText(win: Window): void {
  const set = (id: string, key: Parameters<typeof getString>[0]) => {
    const node = byId(win, id);
    if (node) node.textContent = getString(key);
  };
  set("rp-dash-eyebrow", "dashboard-eyebrow");
  set("rp-dash-title", "dashboard-title");
  set("rp-dash-refresh-label", "dashboard-refresh");
  set("rp-dash-loading-text", "dashboard-loading");
  set("rp-dash-error-title", "dashboard-error-title");
  set("rp-dash-retry", "dashboard-retry");
  set("rp-dash-empty-title", "dashboard-empty-title");
  set("rp-dash-empty-desc", "dashboard-empty-desc");
  set("rp-dash-clear-label", "dashboard-clear");
  const clearBtn = byId(win, "rp-dash-clear");
  clearBtn?.setAttribute("title", getString("dashboard-clear-tip"));
  setSubtitle(win, 0);
}

function setSubtitle(win: Window, count: number): void {
  const node = byId(win, "rp-dash-subtitle");
  if (node) {
    node.textContent = getString("dashboard-subtitle", { args: { count } });
  }
}

function filterLabel(filter: FilterKey): string {
  const key: FtlKey =
    filter === "all" ? "dashboard-tile-all" : `dashboard-group-${filter}`;
  return getString(key);
}

function buildNav(win: Window, state: DashState): void {
  const host = byId(win, "rp-dash-nav");
  if (!host) return;
  host.textContent = "";
  for (const def of NAV_DEFS) {
    const item = el(win, "button", "rp-dash-nav-item") as HTMLButtonElement;
    item.setAttribute("type", "button");
    item.dataset.filter = def.key;
    item.appendChild(el(win, "span", `rp-icon ${def.icon}`));
    item.appendChild(el(win, "span", "", getString(def.labelKey)));
    const count = el(win, "span", "rp-dash-nav-count", "0");
    item.appendChild(count);
    if (def.key === state.filter) {
      item.setAttribute("aria-current", "page");
    }
    host.appendChild(item);
    state.navCounts[def.key] = count;
  }
}

function wireEvents(win: Window, state: DashState): void {
  byId(win, "rp-dash-refresh")?.addEventListener("click", () => {
    void loadJobs(win, state);
  });
  byId(win, "rp-dash-retry")?.addEventListener("click", () => {
    void loadJobs(win, state);
  });
  byId(win, "rp-dash-nav")?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest?.(
      "[data-filter]",
    ) as HTMLElement | null;
    const filter = target?.dataset.filter as FilterKey | undefined;
    if (!filter || filter === state.filter) return;
    state.filter = filter;
    renderAll(win, state);
  });
  byId(win, "rp-dash-list")?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest?.(
      '[data-action="open-detail"]',
    ) as HTMLElement | null;
    if (target?.dataset.jobId) openDetail(target.dataset.jobId);
  });
  byId(win, "rp-dash-clear")?.addEventListener("click", () => {
    if (CLEARABLE_FILTERS.has(state.filter)) {
      void clearGroup(win, state, state.filter as GroupKey);
    }
  });
}

/**
 * 加载列表并驱动全量渲染。手动刷新与 3s 轮询共用此入口;
 * 完成后总是重排下一拍(关窗时 destroyDashboard 已清定时器,不再排)。
 */
async function loadJobs(win: Window, state: DashState): Promise<void> {
  if (state.pollTimer !== null) {
    win.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  const generation = ++state.generation;
  const refreshBtn = byId(win, "rp-dash-refresh");
  refreshBtn?.setAttribute("data-state", "loading");

  const serverBaseURL = (getPref("serverBaseURL") as string) || "";
  if (!serverBaseURL.trim()) {
    state.error = getString("dashboard-no-server");
    state.items = [];
    state.hasLoaded = true;
    renderAll(win, state);
    refreshBtn?.removeAttribute("data-state");
    scheduleNext(win, state);
    return;
  }

  const client = new RetainPdfClient();
  try {
    const items = await client.listJobs({ limit: LIST_LIMIT });
    if (!alive(win, state, generation)) return;
    state.items = items;
    state.error = "";
    state.hasLoaded = true;
    renderAll(win, state);
    syncWatchers(state, client);
  } catch (error) {
    if (!alive(win, state, generation)) return;
    state.error = reason(error);
    state.hasLoaded = true;
    renderAll(win, state);
    void appendPluginLog(`[dashboard] load failed: ${state.error}`);
  } finally {
    if (alive(win, state, generation)) {
      refreshBtn?.removeAttribute("data-state");
      scheduleNext(win, state);
    }
  }
}

function scheduleNext(win: Window, state: DashState): void {
  state.pollTimer = win.setTimeout(() => {
    state.pollTimer = null;
    void loadJobs(win, state);
  }, POLL_MS);
}

/** 活跃任务 SSE:新出现的活跃任务开流,不再活跃的收流。 */
function syncWatchers(state: DashState, client: RetainPdfClient): void {
  const activeIds = new Set(
    state.items
      .filter((job) => isActive(job?.status))
      .map((job) => `${job.job_id || ""}`.trim())
      .filter(Boolean),
  );
  for (const [jobId, close] of Array.from(state.sseClosers)) {
    if (!activeIds.has(jobId)) {
      close();
      state.sseClosers.delete(jobId);
      state.live.delete(jobId);
    }
  }
  for (const jobId of activeIds) {
    if (state.sseClosers.has(jobId)) continue;
    const close = client.watchProgressEvents(
      jobId,
      (event) => {
        // lane=main 优先,diagnostic 兜底(排队期只有诊断事件)
        if (event?.lane !== "main" && event?.lane !== "diagnostic") return;
        const percent = finiteNumber(event?.progress?.percent);
        const stageDetail =
          typeof event?.stage_detail === "string" ? event.stage_detail : "";
        state.live.set(jobId, {
          percent: percent ?? undefined,
          stageDetail,
        });
        pokeCard(state, jobId);
      },
      () => {
        // end 只是信号:收流,终态事实交给下一拍轮询
        state.sseClosers.get(jobId)?.();
        state.sseClosers.delete(jobId);
      },
    );
    state.sseClosers.set(jobId, close);
  }
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isActive(status: unknown): boolean {
  const s = `${status || ""}`.trim().toLowerCase();
  return s === "running" || s === "queued";
}

function groupKeyFor(status: unknown): GroupKey {
  const s = `${status || ""}`.trim().toLowerCase();
  if (s === "running") return "running";
  if (s === "queued") return "queued";
  if (s === "failed") return "failed";
  return "completed";
}

/** 列表行的快照进度(include_live_stage=false 时恒空,靠 SSE 补)。 */
function snapshotPercent(job: any): number | null {
  const progress = job?.stage_snapshot?.progress;
  const percent = finiteNumber(progress?.percent);
  if (percent !== null) return clampPercent(percent);
  const current = finiteNumber(progress?.current);
  const total = finiteNumber(progress?.total);
  if (current !== null && total !== null && total > 0) {
    return clampPercent((current / total) * 100);
  }
  return null;
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

/** 卡片视觉签名:未变则零重排(分钟粒度拍平秒级心跳,列表防抖根因)。 */
function cardSignature(job: any, live: LiveProgress | undefined): string {
  const minute = Math.floor(new Date(job?.updated_at || 0).getTime() / 60000);
  return JSON.stringify([
    job?.status || "",
    job?.display_name || "",
    job?.source_file_name || "",
    job?.workflow || "",
    snapshotPercent(job),
    minute,
    live?.percent != null ? Math.round(live.percent) : -1,
    live?.stageDetail || "",
  ]);
}

function filteredItems(state: DashState): any[] {
  if (state.filter === "all") return state.items;
  return state.items.filter((job) => groupKeyFor(job?.status) === state.filter);
}

function renderAll(win: Window, state: DashState): void {
  if (!state.hasLoaded) {
    showView(win, "loading");
    return;
  }
  if (state.error && state.items.length === 0) {
    const reasonEl = byId(win, "rp-dash-error-reason");
    if (reasonEl) reasonEl.textContent = state.error;
    showView(win, "error");
    return;
  }
  if (state.items.length === 0) {
    showView(win, "empty");
    return;
  }

  const errorbar = byId(win, "rp-dash-errorbar");
  if (errorbar) {
    if (state.error) {
      errorbar.textContent = getString("dashboard-errorbar", {
        args: { reason: state.error },
      });
      errorbar.removeAttribute("hidden");
    } else {
      errorbar.setAttribute("hidden", "hidden");
    }
  }

  setSubtitle(win, state.items.length);
  updateNavCounts(win, state);
  renderContentbar(win, state);

  const items = filteredItems(state);
  if (items.length === 0) {
    const emptyEl = byId(win, "rp-dash-list-empty");
    if (emptyEl) {
      emptyEl.textContent = getString("dashboard-group-empty", {
        args: { label: filterLabel(state.filter) },
      });
    }
    showView(win, "list-empty");
    return;
  }

  showView(win, "list");
  reconcileList(win, state, items);
}

/** 导航计数徽章与选中态(aria-current 驱动 CSS 竖条+淡底)。 */
function updateNavCounts(win: Window, state: DashState): void {
  const counts: Record<FilterKey, number> = {
    all: state.items.length,
    running: 0,
    queued: 0,
    failed: 0,
    completed: 0,
  };
  for (const item of state.items) {
    if (!`${item?.job_id || ""}`.trim()) continue;
    counts[groupKeyFor(item.status)] += 1;
  }
  for (const [key, node] of Object.entries(state.navCounts)) {
    if (node) node.textContent = `${counts[key as FilterKey] ?? 0}`;
  }
  const nav = byId(win, "rp-dash-nav");
  nav?.querySelectorAll(".rp-dash-nav-item").forEach((node: Element) => {
    const item = node as HTMLElement;
    if (item.dataset.filter === state.filter) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  });
}

/** 内容区顶栏:当前视图名 + 清空按钮(仅终态视图且非空时可见)。 */
function renderContentbar(win: Window, state: DashState): void {
  const label = byId(win, "rp-dash-view-label");
  if (label) label.textContent = filterLabel(state.filter);
  const clearBtn = byId(win, "rp-dash-clear") as HTMLButtonElement | null;
  if (clearBtn) {
    const clearing = state.clearingGroup !== null;
    const show =
      CLEARABLE_FILTERS.has(state.filter) && filteredItems(state).length > 0;
    clearBtn.hidden = !show;
    clearBtn.disabled = clearing;
    const clearLabel = byId(win, "rp-dash-clear-label");
    if (clearLabel) {
      clearLabel.textContent = getString(
        state.clearingGroup === state.filter
          ? "dashboard-clearing"
          : "dashboard-clear",
      );
    }
  }
}

type ViewName = "loading" | "error" | "empty" | "list" | "list-empty";

function showView(win: Window, view: ViewName): void {
  const views: Record<ViewName, string> = {
    loading: "rp-dash-loading",
    error: "rp-dash-error",
    empty: "rp-dash-empty",
    list: "rp-dash-list",
    "list-empty": "rp-dash-list-empty",
  };
  for (const [name, id] of Object.entries(views)) {
    const node = byId(win, id);
    if (!node) continue;
    if (name === view) node.removeAttribute("hidden");
    else node.setAttribute("hidden", "hidden");
  }
  // 内容顶栏(视图名+清空)只在有列表语义时出现
  const contentbar = byId(win, "rp-dash-contentbar");
  if (contentbar) {
    if (view === "list" || view === "list-empty") {
      contentbar.removeAttribute("hidden");
    } else {
      contentbar.setAttribute("hidden", "hidden");
    }
  }
}

/**
 * 单栏列表 reconcile:按 job_id 复用卡片,签名未变不动 DOM,
 * 位置不符才 insertBefore;视图外的卡片从 DOM 与缓存一并移除
 * (切回时按最新状态重建,成本可忽略)。
 */
function reconcileList(win: Window, state: DashState, items: any[]): void {
  const list = byId(win, "rp-dash-list");
  if (!list) return;
  items.forEach((job, index) => {
    const jobId = `${job?.job_id || ""}`.trim();
    if (!jobId) return;
    let card = state.cards.get(jobId);
    if (!card) {
      card = buildCard(win, jobId);
      state.cards.set(jobId, card);
    }
    const signature = cardSignature(job, state.live.get(jobId));
    if (card.dataset.signature !== signature) {
      updateCard(card, job, state.live.get(jobId));
      card.dataset.signature = signature;
    }
    if (list.children[index] !== card) {
      list.insertBefore(card, list.children[index] ?? null);
    }
  });
  while (list.children.length > items.length) {
    const removed = list.lastElementChild as HTMLElement | null;
    if (!removed) break;
    if (removed.dataset.jobId) state.cards.delete(removed.dataset.jobId);
    removed.remove();
  }
}

function buildCard(win: Window, jobId: string): HTMLElement {
  const card = el(win, "article", "rp-dash-card");
  card.dataset.jobId = jobId;

  const main = el(win, "div", "rp-dash-card-main");
  const iconWrap = el(win, "div", "rp-dash-card-icon");
  iconWrap.appendChild(el(win, "span", "rp-icon rp-icon--doc"));
  main.appendChild(iconWrap);

  const body = el(win, "div", "rp-dash-card-body");
  const titleRow = el(win, "div", "rp-dash-card-titlerow");
  titleRow.appendChild(
    el(win, "span", "rp-dash-badge", getString("dashboard-badge-doc")),
  );
  const title = el(win, "h3", "rp-dash-card-title");
  titleRow.appendChild(title);
  body.appendChild(titleRow);

  const meta = el(win, "div", "rp-dash-card-meta");
  const taskSpan = el(win, "span");
  taskSpan.append(`${getString("dashboard-task-prefix")} `);
  const code = el(win, "code") as HTMLElement;
  taskSpan.appendChild(code);
  meta.appendChild(taskSpan);
  meta.appendChild(el(win, "span", "rp-meta-workflow"));
  meta.appendChild(el(win, "span", "rp-meta-time"));
  body.appendChild(meta);

  main.appendChild(body);
  main.appendChild(el(win, "span", "rp-dash-pill"));
  card.appendChild(main);

  // 中部进度区:固定占位的弹性带,活跃时底部对齐进度条+stage 文案,
  // 非活跃留白——配合卡片固定高度,所有卡片等高(老板钦定 2026-10-14)
  const zone = el(win, "div", "rp-dash-zone");
  const progress = el(win, "div", "rp-dash-progress");
  progress.setAttribute("hidden", "hidden");
  const track = el(win, "div", "rp-dash-progress-track");
  track.appendChild(el(win, "div", "rp-dash-progress-bar"));
  progress.appendChild(track);
  progress.appendChild(el(win, "span", "rp-dash-progress-pct"));
  zone.appendChild(progress);

  const stage = el(win, "div", "rp-dash-stage");
  stage.setAttribute("hidden", "hidden");
  zone.appendChild(stage);
  card.appendChild(zone);

  const footer = el(win, "div", "rp-dash-card-footer");
  const openBtn = el(
    win,
    "button",
    "rp-dash-btn rp-dash-open",
  ) as HTMLButtonElement;
  openBtn.setAttribute("type", "button");
  openBtn.dataset.action = "open-detail";
  openBtn.dataset.jobId = jobId;
  openBtn.appendChild(el(win, "span", "", getString("dashboard-open-detail")));
  const openIcon = el(win, "span", "rp-icon rp-icon--external rp-icon--sm");
  openBtn.appendChild(openIcon);
  footer.appendChild(openBtn);
  card.appendChild(footer);
  return card;
}

function updateCard(
  card: HTMLElement,
  job: any,
  live: LiveProgress | undefined,
): void {
  const status = `${job?.status || ""}`.trim().toLowerCase();
  const active = isActive(status);
  const percent =
    active && live?.percent != null ? live.percent : snapshotPercent(job);

  const title = card.querySelector(".rp-dash-card-title") as HTMLElement | null;
  const label = `${job?.display_name || job?.source_file_name || ""}`.trim();
  if (title) {
    title.textContent = label || getString("dashboard-unnamed");
    title.setAttribute("title", label);
  }

  const code = card.querySelector("code");
  const jobId = `${job?.job_id || ""}`.trim();
  if (code) {
    code.textContent =
      jobId.length > 18 ? `${jobId.slice(0, 9)}…${jobId.slice(-6)}` : jobId;
    code.setAttribute("title", jobId);
  }

  const workflow = card.querySelector(".rp-meta-workflow");
  if (workflow) workflow.textContent = workflowLabel(job?.workflow);

  const time = card.querySelector(".rp-meta-time");
  if (time) time.textContent = relativeTime(job?.updated_at);

  const pill = card.querySelector(".rp-dash-pill") as HTMLElement | null;
  if (pill) {
    pill.textContent = statusLabel(status);
    pill.dataset.status = status;
  }

  const progress = card.querySelector(
    ".rp-dash-progress",
  ) as HTMLElement | null;
  if (progress) {
    if (active && percent !== null) {
      progress.removeAttribute("hidden");
      const bar = progress.querySelector(
        ".rp-dash-progress-bar",
      ) as HTMLElement | null;
      if (bar) bar.style.width = `${Math.round(percent)}%`;
      const pct = progress.querySelector(".rp-dash-progress-pct");
      if (pct) pct.textContent = `${Math.round(percent)}%`;
    } else {
      progress.setAttribute("hidden", "hidden");
    }
  }

  const stage = card.querySelector(".rp-dash-stage") as HTMLElement | null;
  if (stage) {
    const detail = active ? live?.stageDetail || "" : "";
    if (detail) {
      stage.textContent = detail;
      stage.removeAttribute("hidden");
    } else {
      stage.setAttribute("hidden", "hidden");
    }
  }
}

/** SSE 单卡打点:只更新该卡的进度条与 stage 文案,不触发整列渲染。 */
function pokeCard(state: DashState, jobId: string): void {
  const card = state.cards.get(jobId);
  if (!card) return;
  const job = state.items.find(
    (item) => `${item?.job_id || ""}`.trim() === jobId,
  );
  if (!job) return;
  const live = state.live.get(jobId);
  const signature = cardSignature(job, live);
  if (card.dataset.signature === signature) return;
  updateCard(card, job, live);
  card.dataset.signature = signature;
}

function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return getString("dashboard-status-queued");
    case "running":
      return getString("dashboard-status-running");
    case "failed":
      return getString("dashboard-status-failed");
    case "succeeded":
      return getString("dashboard-status-succeeded");
    case "cancelled":
    case "canceled":
      return getString("dashboard-status-cancelled");
    default:
      return getString("dashboard-status-unknown");
  }
}

function workflowLabel(workflow: unknown): string {
  switch (`${workflow || ""}`.trim().toLowerCase()) {
    case "ocr":
      return getString("dashboard-workflow-ocr");
    case "book":
      return getString("dashboard-workflow-book");
    case "translate":
      return getString("dashboard-workflow-translate");
    case "render":
      return getString("dashboard-workflow-render");
    default:
      return getString("dashboard-workflow-unknown");
  }
}

/** 相对时间(分钟粒度):秒级心跳拍平,避免驱动无意义重渲染。 */
function relativeTime(value: unknown): string {
  const time = new Date(`${value || ""}`).getTime();
  if (!Number.isFinite(time)) return "";
  const diffMs = Date.now() - time;
  if (diffMs < 60000) return getString("dashboard-time-just-now");
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) {
    return getString("dashboard-time-minutes", { args: { minutes } });
  }
  const d = new Date(time);
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** 打开详情:v1 外链浏览器(detail.html 在 web 入口同原点)。 */
function openDetail(jobId: string): void {
  const client = new RetainPdfClient();
  const url = client.baseURLForArtifact(
    `/detail.html?job_id=${encodeURIComponent(jobId)}`,
  );
  // zotero-types 未收 launchInBrowser(Zotero 7 官方 API,内嵌监控台计划的
  // target=_blank 兜底也是它)
  (Zotero as any).launchInBrowser(url);
}

/**
 * 清空终态分组:逐个真删(-ocr 子任务行跳过,随父级联消失),
 * 串行避免磁盘清理互相争抢;删完重拉列表回到服务端真相。
 */
async function clearGroup(
  win: Window,
  state: DashState,
  groupKey: GroupKey,
): Promise<void> {
  if (state.clearingGroup) return;
  const targets = state.items
    .filter((job) => groupKeyFor(job?.status) === groupKey)
    .map((job) => `${job?.job_id || ""}`.trim())
    .filter((jobId) => jobId && !jobId.endsWith("-ocr"));
  if (!targets.length) return;

  state.clearingGroup = groupKey;
  renderAll(win, state);
  const client = new RetainPdfClient();
  let failed = 0;
  for (const jobId of targets) {
    try {
      await client.deleteJob(jobId);
    } catch (error) {
      failed += 1;
      void appendPluginLog(
        `[dashboard] delete ${jobId} failed: ${reason(error)}`,
      );
    }
  }
  state.clearingGroup = null;
  if (failed > 0) {
    state.error = getString("dashboard-clear-partial", { args: { failed } });
  }
  await loadJobs(win, state);
}
