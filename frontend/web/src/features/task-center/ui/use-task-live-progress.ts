import { useEffect, useRef, useState } from "react";
// 任务中心活跃卡片的实时进度(SSE 驱动的行级 patch)。
//
// 每个活跃任务开一条 /progress-events 流:
//   - percent 只消费 lane=main。diagnostic lane 的 percent 是子阶段内部的
//     数字(比如排版修复从 0 重跑),盖到主进度上会出现 60% 倒退回 2% 的
//     可复现 bug;它的 stage_detail 文案仍然对用户有用,保留。
//   - 连接按 jobId 记账,任务集合变化时只增删变化的流,不整体重建。
//   - 瞬时网络错误不手动 close:EventSource 自带重连;只有任务终态
//     (end 事件)、任务离开活跃集合或组件卸载才主动关流。
//
// end 事件回调列表刷新拉终态。apiPrefix 变化重建全部(部署切换场景,
// 实际是常量)。


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
  // onEnded 经 ref 透传,避免调用方每次渲染的新函数影响连接生命周期
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;
  // 连接注册表放在 ref 里跨渲染存活,effect 只做增量对账
  const sourcesRef = useRef(new Map<string, EventSource>());
  const prefixRef = useRef(apiPrefix);
  prefixRef.current = apiPrefix;

  // 数组身份每拍都变(来自 items 推导),用逗号串做 effect 依赖稳定化
  const idsKey = activeJobIds.join(",");

  useEffect(() => {
    const sources = sourcesRef.current;
    const ids = idsKey ? idsKey.split(",") : [];
    const wanted = new Set(ids);

    const patch = (jobId: string, next: TaskLiveProgress) => {
      setLive((prev) => ({ ...prev, [jobId]: { ...prev[jobId], ...next } }));
    };
    const open = (jobId: string) => {
      if (sources.has(jobId) || typeof window.EventSource === "undefined") return;
      const EventSourceCtor = window.EventSource;
      const es = new EventSourceCtor(
        `${prefixRef.current}/api/v1/jobs/${encodeURIComponent(jobId)}/progress-events`,
      );
      es.addEventListener("progress", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data || "{}");
          // 主进度只认 main lane;diagnostic 只贡献阶段文案
          if (payload?.lane === "main") {
            patch(jobId, {
              percent: payload?.progress?.percent,
              stageDetail: `${payload?.stage_detail || ""}`.trim() || undefined,
            });
          } else if (payload?.lane === "diagnostic") {
            const detail = `${payload?.stage_detail || ""}`.trim();
            if (detail) patch(jobId, { stageDetail: detail });
          }
        } catch { /* 非 JSON 帧忽略 */ }
      });
      es.addEventListener("end", () => {
        es.close();
        sources.delete(jobId);
        setLive((prev) => {
          if (!(jobId in prev)) return prev;
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
        endedRef.current(jobId);
      });
      es.onerror = () => {
        // 瞬时断网:readyState 仍是 CONNECTING,浏览器自动重连,不干预。
        // 只有永久失败(如任务被删后服务端 404,CLOSED)才摘掉这条流;
        // 终态兜底仍由列表轮询的 discover 承担。
        if (es.readyState === window.EventSource?.CLOSED) {
          sources.delete(jobId);
        }
      };
      sources.set(jobId, es);
    };
    const close = (jobId: string) => {
      const es = sources.get(jobId);
      if (!es) return;
      es.close();
      sources.delete(jobId);
    };

    for (const jobId of ids) open(jobId);
    for (const jobId of [...sources.keys()]) {
      if (!wanted.has(jobId)) close(jobId);
    }
    // 已移除任务的进度缓存及时清理,避免旧状态长期滞留
    setLive((prev) => {
      const kept = Object.keys(prev).filter((jobId) => wanted.has(jobId));
      if (kept.length === Object.keys(prev).length) return prev;
      const next: Record<string, TaskLiveProgress> = {};
      for (const jobId of kept) next[jobId] = prev[jobId];
      return next;
    });
    // 连接的关闭只发生在:任务终态(end)、离开活跃集合(上面的对账)、
    // 组件卸载(下面的卸载 effect)。本 effect 的依赖变化不整体重建。
  }, [idsKey]);

  // 卸载时关掉全部流;普通渲染路径不经过这个清理
  useEffect(() => () => {
    for (const es of sourcesRef.current.values()) es.close();
    sourcesRef.current.clear();
  }, []);

  return live;
}
