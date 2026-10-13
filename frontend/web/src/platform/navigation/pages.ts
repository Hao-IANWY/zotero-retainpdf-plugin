// 两页导航统一契约：home / detail。
//
// - home:   index.html（任务列表）
// - detail: detail.html?job_id=<jobId>（单任务状态页）
//
// 跳转统一走 navigateTo()。

export function parseDetailJobId(search?: string): string {
  const query = search ?? (typeof globalThis.location !== "undefined" ? globalThis.location.search : "");
  try {
    return `${new URLSearchParams(query).get("job_id") || ""}`.trim();
  } catch {
    return "";
  }
}

export function buildDetailUrl(jobId: string): string {
  const id = `${jobId || ""}`.trim();
  if (!id) return "";
  return `./detail.html?job_id=${encodeURIComponent(id)}`;
}

/** 全站唯一跳转出口：assign（默认）/ replace（深链、避免返回死循环）。 */
export function navigateTo(url: string, options: { replace?: boolean } = {}): void {
  const target = `${url || ""}`.trim();
  if (!target || typeof window === "undefined") return;
  if (options.replace) window.location.replace(target);
  else window.location.assign(target);
}
