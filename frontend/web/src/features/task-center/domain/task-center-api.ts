import type { JobListItemView, JobListView } from "@retainpdf/contracts/job-status";
import { API_PREFIX } from "@/platform/config/api-constants.js";
import {
  deleteLibraryBook,
  fetchJobList,
  fetchJobPayload,
} from "@/platform/api/index.js";

// 任务中心不提供取消/重试等运行干预(一律走 Zotero 插件或 API 客户端);
// 「清空历史」例外:调 DELETE /api/v1/library/books/{job_id} 真删后端记录
// 与磁盘产物(任务维度,源 PDF 保留),运行中任务后端会 409 拒绝。

export const TASK_CENTER_PAGE_LIMIT = 50;
export const TASK_CENTER_MAX_ITEMS = 2000;

export type TaskCenterLoadResult = {
  items: JobListItemView[];
  reachedLimit: boolean;
  hasMore: boolean;
  nextOffset: number;
};

export type TaskCenterApiDependencies = {
  fetchList: typeof fetchJobList;
  fetchDetail: typeof fetchJobPayload;
  deleteJob: typeof deleteLibraryBook;
};

const DEFAULT_DEPENDENCIES: TaskCenterApiDependencies = {
  fetchList: fetchJobList,
  fetchDetail: fetchJobPayload,
  deleteJob: deleteLibraryBook,
};

export async function loadTaskCenterJobs(
  dependencies: Pick<TaskCenterApiDependencies, "fetchList"> = DEFAULT_DEPENDENCIES,
  { offset = 0 }: { offset?: number } = {},
): Promise<TaskCenterLoadResult> {
  const start = Math.min(TASK_CENTER_MAX_ITEMS, Math.max(0, Math.trunc(offset) || 0));
  if (start >= TASK_CENTER_MAX_ITEMS) {
    return { items: [], reachedLimit: true, hasMore: false, nextOffset: start };
  }
  const limit = Math.min(TASK_CENTER_PAGE_LIMIT, TASK_CENTER_MAX_ITEMS - start);
  const page = await dependencies.fetchList(API_PREFIX, {
    limit, offset: start, includeLiveStage: false,
  }) as JobListView;
  const pageItems = Array.isArray(page?.items) ? page.items : [];
  const items: JobListItemView[] = [];
  const seen = new Set<string>();
  for (const item of pageItems) {
    const jobId = `${item?.job_id || ""}`.trim();
    if (jobId && !seen.has(jobId)) {
      seen.add(jobId);
      items.push(item);
    }
  }
  const nextOffset = start + pageItems.length;
  const reachedLimit = nextOffset >= TASK_CENTER_MAX_ITEMS;
  return { items, reachedLimit, nextOffset, hasMore: !reachedLimit && pageItems.length === limit };
}

/** Hydrate only visible active tasks; completed history never gates first paint. */
export async function loadTaskCenterLiveJobs(
  items: JobListItemView[],
  dependencies: Pick<TaskCenterApiDependencies, "fetchDetail"> = DEFAULT_DEPENDENCIES,
): Promise<JobListItemView[]> {
  const active = items.filter((item) => (
    item.status === "running" || item.status === "queued"
  ));
  const result: JobListItemView[] = [];
  let offset = 0;
  async function worker() {
    while (offset < active.length) {
      const item = active[offset++];
      try {
        const detail = await dependencies.fetchDetail(item.job_id, { apiPrefix: API_PREFIX });
        if (detail?.job_id === item.job_id) result.push({ ...item, ...detail });
      } catch {
        // One missing task must not discard another task's live progress.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, active.length) }, () => worker()));
  return result;
}

/**
 * 从「第 0 页」里挑出手上还没有的任务。
 *
 * 任务中心的 3s 周期只对已在列表里的 job 拉详情，拉列表只在挂载/手动刷新/
 * 加载更多时发生——所以别处新建的任务此前永远不会出现，直到用户点刷新。
 *
 * 列表是新任务在前，因此第 0 页里我们没有的那些必然比手上全部都新，调用方
 * 应当**前插**而不是用 mergeTaskCenterJobs 追加到末尾（那会让顺序错位）。
 * 返回值同时给出 addedCount，调用方据此把分页游标后移同样的距离：服务端列表
 * 整体右移了这么多，不移的话「加载更多」会重复取到已有的那几条。
 */
export function discoverNewTaskCenterJobs(
  previous: JobListItemView[],
  pageItems: JobListItemView[],
): { fresh: JobListItemView[]; addedCount: number } {
  const known = new Set(
    (Array.isArray(previous) ? previous : [])
      .map((item) => `${item?.job_id || ""}`.trim())
      .filter(Boolean),
  );
  const fresh = (Array.isArray(pageItems) ? pageItems : []).filter((item) => {
    const jobId = `${item?.job_id || ""}`.trim();
    return Boolean(jobId) && !known.has(jobId);
  });
  return { fresh, addedCount: fresh.length };
}

export function mergeTaskCenterJobs(previous: JobListItemView[], incoming: JobListItemView[]) {
  const updates = new Map(incoming.map((item) => [item.job_id, item]));
  const merged = previous.map((item) => {
    const next = updates.get(item.job_id);
    updates.delete(item.job_id);
    if (!next || (item.updated_at && next.updated_at && item.updated_at > next.updated_at)) return item;
    return next;
  });
  return [...merged, ...updates.values()];
}

/**
 * 清空历史:逐个真删后端任务。`xxx-ocr` 子任务行跳过——它们随父任务的
 * 删除在后端级联消失,单独删会被馆藏入口当 OCR 任务拒绝(404)。
 * 返回 {deleted, failed}:失败数给 UI 提示,成功的部分不回滚。
 */
export async function deleteTaskCenterHistory(
  jobs: Pick<JobListItemView, "job_id">[],
  dependencies: Pick<TaskCenterApiDependencies, "deleteJob"> = DEFAULT_DEPENDENCIES,
): Promise<{ deleted: number; failed: number }> {
  const targets = jobs
    .map((job) => `${job?.job_id || ""}`.trim())
    .filter((jobId) => jobId && !jobId.endsWith("-ocr"));
  let deleted = 0;
  let failed = 0;
  // 串行:后端删除是「先事务删行再清磁盘」,并发批量会在磁盘清理上互相争抢。
  // 不对 -ocr 行调删除——canonical 实现会剥掉 -ocr 后缀转删父任务,而父可能
  // 在另一组(父 failed / 子 succeeded),清 completed 组时不能误删 failed 的父。
  for (const jobId of targets) {
    try {
      await dependencies.deleteJob(API_PREFIX, jobId);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed };
}
