import { useEffect } from "react";


//
// 任务详情页的实时进度通道。
//
// 主通道是 SSE(`/api/v1/jobs/{id}/progress-events`):progress 事件轻量刷新
// 「当前阶段」文案(不动全页),end 事件触发终态全量收尾。拿不到流(老后端、
// 代理吞流、断线)自动降级为 1s 全景轮询——两条通道终态都会调用
// `refresh(true)` 让页面停在完整形态。
//
// 从 DetailApp 抽出:实时通道是独立关注点,且 DetailApp 已在体量棘轮边缘。

export type LiveProgressOptions = {
  jobId: string | null;
  apiPrefix: string;
  /** 运行中的任务才需要通道;终态任务(直开详情页/历史任务)直接不启动 */
  isActive: boolean;
  onStage: (stageDetail: string) => void;
  /** 终态全量收尾(拉产物/失败诊断/markdown),幂等,失败静默 */
  onTerminal: () => void | Promise<void>;
  /** 降级轮询的一拍全景刷新,返回任务 status(小写);失败抛错 */
  pollOnce: () => Promise<string>;
};

export function useLiveProgressEffect({
  jobId,
  apiPrefix,
  isActive,
  onStage,
  onTerminal,
  pollOnce,
}: LiveProgressOptions): void {
  useEffect(() => {
    if (!jobId || !isActive) return;
    let stopped = false;
    let es: EventSource | null = null;
    let ended = false;

    const pollLoop = async () => {
      while (!stopped) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        if (stopped) return;
        try {
          const status = (await pollOnce()).trim().toLowerCase();
          if (["succeeded", "failed", "canceled"].includes(status)) {
            await onTerminal();
            return;
          }
        } catch {
          // 单拍失败不中断;网络恢复后自然续上
        }
      }
    };

    const startSse = () => {
      if (typeof window.EventSource === "undefined") {
        void pollLoop();
        return;
      }
      es = new EventSource(
        // apiPrefix 是 API 级前缀(/api/v1,见 data-port.ts 默认值);
        // 此前多拼一层 /api/v1 导致 SSE 全程 404,一直靠轮询兜底撑着。
        `${apiPrefix}/jobs/${encodeURIComponent(jobId)}/progress-events`,
      );
      es.addEventListener("progress", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data || "{}");
          const detail = `${payload?.stage_detail || ""}`.trim();
          if (detail) onStage(detail);
        } catch {
          /* 非 JSON 帧忽略 */
        }
      });
      es.addEventListener("end", () => {
        ended = true;
        es?.close();
        es = null;
        void onTerminal();
      });
      es.onerror = () => {
        // 服务器关流且未发 end(或连接失败):切轮询兜底。
        // ended 后 EventSource 的自动重连报错不算故障,忽略。
        es?.close();
        es = null;
        if (!ended && !stopped) void pollLoop();
      };
    };

    startSse();
    return () => {
      stopped = true;
      es?.close();
    };
    // 通道只随任务身份重建;回调由调用方保证稳定语义(闭包读最新 state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, apiPrefix, isActive]);
}

