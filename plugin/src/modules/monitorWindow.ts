import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import type { DialogHelper } from "zotero-plugin-toolkit";

/**
 * RetainPDF 监控台窗口(docs/ops/planning/zotero-monitor-window.md)。
 * 形态:ztoolkit.Dialog 非模态大窗内嵌 XUL <browser> 直接加载监控台现网
 * HTML——插件不实现任何列表/详情 UI,监控台改版零跟进。web 容器同原点
 * 服务静态页与 /api/ 反代,页面内 fetch/SSE 行为与浏览器完全一致。
 *
 * 鉴权硬约束:iframe 导航注入不了自定义请求头,Cloudflare Access 公网形态
 * 此窗口天然不可用;v1 仅支持无边缘认证直连(本机/内网/tailscale)。
 * 详情页 target=_blank 链接在此无默认行为,v1 容忍(计划风险表已接受)。
 */

/** 单例状态:窗口开着就不重复开,只聚焦。 */
let dialog: DialogHelper | null = null;

/** 几何记忆 pref(JSON 字符串):关窗时存 left/top/width/height,开窗原样恢复。 */
const GEOMETRY_PREF = "monitorWindow";
const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 750;

/** 监控台根:显式 monitorUrl 优先,留空从 serverBaseURL 推导(nginx 同原点服务静态页)。 */
function monitorRootURL(): string {
  return (
    (getPref("monitorUrl") as string) ||
    (getPref("serverBaseURL") as string) ||
    ""
  ).replace(/\/+$/, "");
}

/** 「工具」菜单 + 条目右键菜单双入口。 */
export function registerMonitorMenuItems() {
  const open = () => void openMonitorWindow();
  for (const menuId of ["menuTools", "item"] as const) {
    ztoolkit.Menu.register(menuId, {
      tag: "menuitem",
      id: `zotero-${menuId === "item" ? "itemmenu" : "toolsmenu"}-${config.addonRef}-monitor`,
      label: getString("menu-monitor-label"),
      icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
      commandListener: open,
    });
  }
}

/**
 * 打开监控台窗口。开窗前先 GET 一次 index.html:serverBaseURL 直指
 * rust_api(:41000)时控制台不在那,与其开一个白窗口,不如直接给
 * 「改指 web 入口 / 填监控台地址」的可操作提示。运行中断网由 Gecko
 * 自带 neterror 页兜底(有重试按钮,非白屏)。
 */
export async function openMonitorWindow(): Promise<void> {
  if (dialog?.window && !dialog.window.closed) {
    dialog.window.focus();
    return;
  }
  const root = monitorRootURL();
  if (!root) {
    notifyMonitor(getString("monitor-notify-no-server"));
    return;
  }
  try {
    const probe = await Zotero.HTTP.request("GET", `${root}/index.html`, {
      responseType: "text",
      timeout: 5000,
    });
    if (probe.status !== 200) {
      throw new Error(`HTTP ${probe.status}`);
    }
  } catch (error) {
    const reason =
      error instanceof Error && error.message ? error.message : "network error";
    notifyMonitor(
      getString("monitor-notify-unreachable", { args: { reason } }),
    );
    return;
  }
  buildWindow(root);
}

/** 插件停用/重启时关窗,避免悬空窗口指向已注销的资源。 */
export function closeMonitorWindow() {
  if (dialog?.window && !dialog.window.closed) {
    dialog.window.close();
  }
  dialog = null;
}

function buildWindow(root: string) {
  const geo = loadGeometry();
  const next = new ztoolkit.Dialog(1, 1);
  next.addCell(
    0,
    0,
    {
      tag: "browser",
      namespace: "xul",
      id: `${config.addonRef}-monitor-browser`,
      attributes: { flex: 1, src: `${root}/index.html` },
    },
    true,
  );
  next.setDialogData({
    // beforeUnload 时窗口尚在、元素仍可访问:此刻读几何最可靠
    beforeUnloadCallback: saveGeometry,
    unloadCallback: () => {
      dialog = null;
    },
  });
  next.open(getString("monitor-window-title"), {
    width: geo.width,
    height: geo.height,
    ...(geo.left != null
      ? { left: geo.left, top: geo.top }
      : { centerscreen: true }),
    resizable: true,
    // 非 dialog=no 的窗口只有关闭按钮,主窗口形态要最大化/最小化
    noDialogMode: true,
    fitContent: false,
  });
  dialog = next;
}

function loadGeometry(): {
  left?: number;
  top?: number;
  width: number;
  height: number;
} {
  const fallback = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  try {
    const raw = JSON.parse((getPref("monitorWindow") as string) || "{}");
    const width = Number(raw.width);
    const height = Number(raw.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return fallback;
    const left = Number(raw.left);
    const top = Number(raw.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      return { left, top, width, height };
    }
    return { width, height };
  } catch {
    return fallback;
  }
}

function saveGeometry() {
  const win = dialog?.window;
  if (!win || win.closed) return;
  try {
    setPref(
      "monitorWindow",
      JSON.stringify({
        left: win.screenX,
        top: win.screenY,
        width: win.outerWidth,
        height: win.outerHeight,
      }),
    );
  } catch {
    // 几何存不上无伤大雅,下次开窗回默认尺寸
  }
}

function notifyMonitor(text: string) {
  const progress = new Zotero.ProgressWindow({ closeOnClick: true });
  progress.changeHeadline(config.addonName);
  progress.show();
  progress.addLines(
    text,
    `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
  );
  progress.startCloseTimer(8000);
}
