import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { appendPluginLog } from "../utils/log";
import { destroyDashboard, initDashboard } from "./dashboardScript";

/**
 * RetainPDF 中控台窗口(docs/ops/planning/zotero-native-dashboard.md)。
 * 形态:openDialog 直开 chrome:// 自带 dashboard.xhtml(preferences.xhtml
 * 同管线),页面本地加载零网络依赖——服务不可达由页面内错误态呈现,开窗
 * 不再探测,也没有 iframe/neterror 一类 Gecko 玄学。取代 v0.1.7–v0.1.10
 * 的 Dialog+iframe 嵌现网监控台路线(结构性问题见探索报告 §2)。
 *
 * 窗口脚本零内联:新开 chrome 窗口的作用域里没有 Zotero 全局,不能走
 * preferences.xhtml 的 onload 内联派发;load/unload 监听由开窗方挂,
 * initDashboard/destroyDashboard 在插件沙箱里操作窗口文档。
 *
 * 入口:唯一入口 = 搜索栏右侧按钮(#zotero-items-toolbar 注入,
 * zotero-tb-search 右邻;Zotero 7 没有 #zotero-toolbar,菜单一律不挂)。
 * 窗口单例:开着就聚焦,不重复开。几何记忆:关窗存 left/top/width/height。
 */

let dashboardWin: Window | null = null;

const GEOMETRY_PREF = "dashboardWindow";
// GitHub 式单栏布局:侧栏 200 + 内容限宽 780 + 留白,窗口无需更宽
const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 800;

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const TOOLBAR_BUTTON_ID = `zotero-tb-${config.addonRef}-monitor`;

/** 唯一入口:搜索栏右侧按钮。逐层回退防 Zotero 改版;逐窗口注入,按 id 去重。 */
export function registerDashboardEntry(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  if (doc.getElementById(TOOLBAR_BUTTON_ID)) return;
  // 按钮注入 #zotero-items-toolbar(条目工具栏,搜索框所在 hbox)紧贴搜索框
  // 右侧(insertBefore searchBox.nextSibling)——appendChild 在 Zotero 7.1+
  // 会落到堆叠模式切换按钮之后,偏离老板钦定位置。
  const anchor =
    doc.getElementById("zotero-items-toolbar") ??
    doc.getElementById("zotero-tb-search")?.parentElement ??
    doc.getElementById("zotero-toolbar-item-tree");
  if (!anchor) {
    void appendPluginLog(
      "[dashboard] neither #zotero-items-toolbar nor fallback found, button skipped",
    );
    return;
  }
  const btn = doc.createElementNS(
    XUL_NS,
    "toolbarbutton",
  ) as unknown as HTMLElement;
  btn.id = TOOLBAR_BUTTON_ID;
  btn.classList.add("zotero-tb-button");
  btn.setAttribute("tooltiptext", getString("dashboard-window-title"));
  // image 属性 = favicon 兜底(经实测两主题可见);list-style-image = 专属
  // monitor.svg(自带明暗两套描边)。双保险:Zotero 7 工具栏对两种图标机制
  // 的覆盖随版本变,只设一种有过不显示的先例(v0.1.8)。
  btn.setAttribute(
    "image",
    `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
  );
  btn.style.listStyleImage = `url("chrome://${config.addonRef}/content/ui/icons/monitor.svg")`;
  btn.addEventListener("command", () => openDashboardWindow());
  const searchBox = doc.getElementById("zotero-tb-search");
  const before =
    searchBox && searchBox.parentElement === anchor
      ? searchBox.nextSibling
      : null;
  anchor.insertBefore(btn, before);
  void appendPluginLog(
    `[dashboard] toolbar button injected under #${anchor.id || anchor.tagName}`,
  );
}

/** 窗口卸载时摘掉该窗口的工具栏按钮(菜单注册由 ztoolkit.unregisterAll 兜底)。 */
export function removeDashboardEntry(win: Window) {
  win.document.getElementById(TOOLBAR_BUTTON_ID)?.remove();
}

/** 打开中控台窗口。单例:开着就聚焦,不重复开。 */
export function openDashboardWindow(): void {
  if (dashboardWin && !dashboardWin.closed) {
    dashboardWin.focus();
    return;
  }
  const geo = loadGeometry();
  const features = [
    "chrome",
    // 非 dialog=no 的窗口只有关闭按钮,主窗口形态要最大化/最小化
    "dialog=no",
    "resizable=yes",
    `width=${geo.width}`,
    `height=${geo.height}`,
    geo.left != null ? `left=${geo.left},top=${geo.top}` : "centerscreen",
  ].join(",");
  const mainWin = Zotero.getMainWindow() as any;
  const win = mainWin?.openDialog(
    `chrome://${config.addonRef}/content/dashboard/dashboard.xhtml`,
    `${config.addonRef}-dashboard`,
    features,
  ) as Window | null;
  if (!win) {
    void appendPluginLog("[dashboard] openDialog returned null");
    return;
  }
  dashboardWin = win;
  void appendPluginLog("[dashboard] window opened");
  win.addEventListener("load", () => {
    try {
      initDashboard(win);
    } catch (error) {
      void appendPluginLog(`[dashboard] init FAILED: ${describeThrown(error)}`);
    }
  });
  // beforeunload 时窗口尚在、尺寸仍可读:此刻存几何最可靠
  win.addEventListener("beforeunload", () => saveGeometry(win));
  win.addEventListener("unload", () => {
    destroyDashboard(win);
    if (dashboardWin === win) dashboardWin = null;
  });
}

/** 插件停用/重启时关窗,避免悬空窗口指向已注销的资源。 */
export function closeDashboardWindow() {
  if (dashboardWin && !dashboardWin.closed) {
    dashboardWin.close();
  }
  dashboardWin = null;
}

/** 把任意抛出物拍平成单行日志文本:Error 取栈首行,对象取 JSON。 */
function describeThrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function loadGeometry(): {
  left?: number;
  top?: number;
  width: number;
  height: number;
} {
  const fallback = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  try {
    const raw = JSON.parse((getPref("dashboardWindow") as string) || "{}");
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

function saveGeometry(win: Window) {
  if (win.closed) return;
  try {
    setPref(
      "dashboardWindow",
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
