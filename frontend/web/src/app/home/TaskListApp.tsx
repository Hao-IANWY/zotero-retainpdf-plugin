// 任务列表页主体（index.html → dist/app.bundle.js）。
// 网页端已收缩为「任务列表 + 任务详情」两页：这里只做一件事——
// 把 TaskCenter 作为页面主内容挂起来，行点击跳 detail.html?job_id=…。
//
// <DownloadToastHost /> 必须挂：TaskCenter 的取消/重试用 sonner toast，
// 每页恰好一个 Toaster 宿主（detail 页在 DetailApp 内自挂一份）。

import { TaskCenter } from "@/features/task-center/index.js";
import { DownloadToastHost } from "@/ui/download-toast/DownloadToastHost.jsx";
import { buildDetailUrl, navigateTo } from "@/platform/navigation/pages.js";

export function TaskListApp() {
  return (
    <>
      <main id="app-shell" className="page app-shell" data-home-spa="">
        <TaskCenter
          onOpenBookDetail={(input) => {
            const url = buildDetailUrl(`${input.job_id || ""}`);
            if (url) navigateTo(url);
          }}
        />
      </main>
      <DownloadToastHost />
    </>
  );
}
