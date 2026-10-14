/**
 * 插件本地日志:Zotero profile 下的 retainpdf-plugin.log,追加写+体积裁剪。
 * 生产环境 console 不可见,排查"点了没反应/打不开"类反馈的唯一手段——
 * 让老板把这个文件发回来即可定位。翻译主线与监控台开窗共用。
 */

const LOG_FILE_NAME = "retainpdf-plugin.log";
const LOG_MAX_BYTES = 512 * 1024;

export async function appendPluginLog(line: string): Promise<void> {
  try {
    const path = `${Zotero.getProfileDirectory().path}/${LOG_FILE_NAME}`;
    let previous = "";
    try {
      previous = ((await Zotero.File.getContentsAsync(path)) as string) || "";
    } catch {
      // 首次运行无文件
    }
    const next = `${previous}[${new Date().toISOString()}] ${line}\n`;
    // 超限从头截断,保最近一半,避免日志无限膨胀
    const trimmed =
      next.length > LOG_MAX_BYTES
        ? next.slice(Math.floor(next.length - LOG_MAX_BYTES / 2))
        : next;
    await Zotero.File.putContentsAsync(path, trimmed);
  } catch {
    // 日志失败绝不影响主流程
  }
}
