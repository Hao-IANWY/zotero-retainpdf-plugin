import { useEffect, useRef, useState } from "react";
// 任务中心活跃卡片的实时进度(SSE 驱动的行级 patch)。
//
// 每个活跃任务开一条 /progress-events 流:progress 事件只更新本行的
// {percent, stageDetail},不触碰 items 数组——这是主页抖动的根治点,
// 轮询路线必须 setItems 触发全列表 reconciliation,而这里只有变化的行
// 重渲染,进度条由 CSS transition 平滑滑动。end 事件回调列表刷新拉终态。
//
// 任务进出活跃集合时增减流;apiPrefix 变化重建全部。


export type TaskLiveProgress = {
  percent?: number;
  stageDetail?: string;
};

export function useTaskLiveProgress(
  activeJobIds: string[],
  apiPrefix: string,
  onEnded: (jobId: string) => void,
): Record<string, TaskLiveProgress> {
  const [live, setLive] = useState<Record<string, TaskLiveProgress>>({});
  // onEnded 经 ref 透传,避免调用方每次渲染的新函数重建全部流
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  // 数组身份每拍都变(来自 items 推导),用逗号串做 effect 依赖稳定化
  const idsKey = activeJobIds.join(",");

  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (!ids.length) return;
    const sources = new Map<string, EventSource>();
    const patch = (jobId: string, next: TaskLiveProgress) => {
      setLive((prev) => ({ ...prev, [jobId]: { ...prev[jobId], ...next } }));
    };
    for (const jobId of ids) {
      if (typeof window.EventSource === "undefined") return;
      const es = new EventSource(
        `${apiPrefix}/api/v1/jobs/${encodeURIComponent(jobId)}/progress-events`,
      );
      es.addEventListener("progress", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data || "{}");
          if (payload?.lane === "main" || payload?.lane === "diagnostic") {
            patch(jobId, {
              percent: payload?.progress?.percent,
              stageDetail: `${payload?.stage_detail || ""}`.trim() || undefined,
            });
          }
        } catch { /* 非 JSON 帧忽略 */ }
      });
      es.addEventListener("end", () => {
        es.close();
        sources.delete(jobId);
        endedRef.current(jobId);
      });
      es.onerror = () => {
        // 老后端 404/断线:关流静默——终态兜底由列表轮询的 discover 承担
        es.close();
        sources.delete(jobId);
      };
      sources.set(jobId, es);
    }
    return () => {
      for (const es of sources.values()) es.close();
    };
  }, [idsKey, apiPrefix]);

  return live;
}

