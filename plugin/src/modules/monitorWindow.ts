import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { appendPluginLog } from "../utils/log";
import type { DialogHelper } from "zotero-plugin-toolkit";

/**
 * RetainPDF 监控台窗口(docs/ops/planning/zotero-monitor-window.md)。
 * 形态:ztoolkit.Dialog 非模态大窗内嵌 XUL <browser> 直接加载监控台现网
 * HTML——插件不实现任何列表/详情 UI,监控台改版零跟进。web 容器同原点
 * 服务静态页与 /api/ 反代,页面内 fetch/SSE 行为与浏览器完全一致。
 *
 * 入口:主窗口工具栏按钮(#zotero-toolbar 注入) + 「工具」菜单兜底;
 * 条目右键菜单不挂(翻译动作独占右键菜单,监控台与条目无关)。
 *
 * 地址:监控台地址就是服务地址(web 入口同原点),不开放单独配置。
 *
 * 两个硬约束:
 * - browser 必须显式 type="content":Dialog 经 openDialog("about:blank")
 *   开的是 chrome 文档,browser 默认按 chrome 权限加载,Gecko 拒绝远程
 *   URL 以 chrome 加载,不设就是白屏。
 * - iframe 导航注入不了自定义请求头,Cloudflare Access 公网形态此窗口
 *   天然不可用;v1 仅支持无边缘认证直连(本机/内网/tailscale)。
 * 详情页 target=_blank 链接在此无默认行为,v1 容忍(计划风险表已接受)。
 */

/** 单例状态:窗口开着就不重复开,只聚焦。 */
let dialog: DialogHelper | null = null;

/** 几何记忆 pref(JSON 字符串):关窗时存 left/top/width/height,开窗原样恢复。 */
const GEOMETRY_PREF = "monitorWindow";
const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 750;

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const TOOLBAR_BUTTON_ID = `zotero-tb-${config.addonRef}-monitor`;

/** 监控台地址即服务地址(web 入口同原点服务静态页与 /api)。 */
function monitorRootURL(): string {
  return ((getPref("serverBaseURL") as string) || "").replace(/\/+$/, "");
}

/** 「工具」菜单兜底入口 + 搜索栏右侧按钮(老板钦定位置)。 */
export function registerMonitorEntry(win: _ZoteroTypes.MainWindow) {
  const open = () => void openMonitorWindow();
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    id: `zotero-toolsmenu-${config.addonRef}-monitor`,
    label: getString("menu-monitor-label"),
    icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    commandListener: open,
  });

  // 按钮注入到 #zotero-items-toolbar 末尾——Zotero 7 主窗口条目工具栏里
  // spacer 之后的搜索区(搜索框 #zotero-tb-search 的父容器),即老板钦定的
  // 搜索栏右侧位置;逐层回退防 Zotero 改版。逐窗口注入,按 id 去重。
  const doc = win.document;
  if (doc.getElementById(TOOLBAR_BUTTON_ID)) return;
  const anchor =
    doc.getElementById("zotero-items-toolbar") ??
    doc.getElementById("zotero-tb-search")?.parentElement ??
    doc.getElementById("zotero-toolbar-item-tree");
  if (!anchor) {
    void appendPluginLog(
      "[monitor] neither #zotero-tb-search nor #zotero-toolbar found, button skipped",
    );
    return;
  }
  const btn = doc.createElementNS(
    XUL_NS,
    "toolbarbutton",
  ) as unknown as HTMLElement;
  btn.id = TOOLBAR_BUTTON_ID;
  btn.classList.add("zotero-tb-button");
  btn.setAttribute("tooltiptext", getString("monitor-window-title"));
  // image 属性与 list-style-image 双保险:Zotero 7 工具栏对两种图标机制
  // 的覆盖随版本变,只设一种有过不显示的先例
  const iconUrl = `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`;
  btn.setAttribute("image", iconUrl);
  btn.style.listStyleImage = `url(${iconUrl})`;
  btn.addEventListener("command", open);
  anchor.appendChild(btn);
  void appendPluginLog(
    `[monitor] toolbar button injected under #${anchor.id || anchor.tagName}`,
  );
}

/** 窗口卸载时摘掉该窗口的工具栏按钮(菜单注册由 ztoolkit.unregisterAll 兜底)。 */
export function removeMonitorEntry(win: Window) {
  win.document.getElementById(TOOLBAR_BUTTON_ID)?.remove();
}

/**
 * 打开监控台窗口。开窗前先 GET 一次 index.html:serverBaseURL 直指
 * rust_api(:41000)或被边缘认证拦截时控制台不在那,与其开一个白窗口,
 * 不如直接给「确认服务地址指向 web 入口」的可操作提示。运行中断网由
 * Gecko 自带 neterror 页兜底(有重试按钮,非白屏)。
 */
export async function openMonitorWindow(): Promise<void> {
  if (dialog?.window && !dialog.window.closed) {
    dialog.window.focus();
    return;
  }
  const root = monitorRootURL();
  void appendPluginLog(`[monitor] open requested, root=${root || "(empty)"}`);
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
    void appendPluginLog(
      `[monitor] probe FAILED: ${describeThrown(error)}${proxyHintForLan(root)}`,
    );
    notifyMonitor(
      getString("monitor-notify-unreachable", {
        args: { reason: describeThrown(error) },
      }),
    );
    return;
  }
  void appendPluginLog("[monitor] probe ok, building window");
  try {
    buildWindow(root);
  } catch (error) {
    // 开窗本身崩了( Dialog/browser 异常 ):不留静默,写日志+弹通知
    void appendPluginLog(`[monitor] buildWindow FAILED: ${describeThrown(error)}`);
    notifyMonitor(
      getString("monitor-notify-unreachable", {
        args: { reason: `window: ${describeThrown(error)}` },
      }),
    );
  }
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

/**
 * 内网地址(本机/tailscale/私网段) + Zotero 代理开启 = 探测失败的第一嫌疑
 * (系统 curl 直连通、Zotero 内走代理挂)。日志里直接点名代理配置,
 * 老板发回日志时一眼定位,不用再问一轮。
 */
function proxyHintForLan(root: string): string {
  const isLan =
    /^https?:\/\/(localhost|127\.|10\.|100\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      root,
    );
  if (!isLan) return "";
  try {
    const { Services } = (globalThis as any).ChromeUtils.importESModule(
      "resource://gre/modules/Services.sys.mjs",
    );
    const type = Services.prefs.getIntPref("network.proxy.type", 0);
    if (type === 0) return "";
    const noProxy = Services.prefs.getCharPref(
      "network.proxy.no_proxies_on",
      "",
    );
    return ` | proxy enabled (type=${type}, no_proxies_on="${noProxy}")`;
  } catch {
    return "";
  }
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
      attributes: {
        type: "content",
        disablehistory: "true",
        flex: 1,
        src: `${root}/index.html`,
      },
      // browser 内部加载成败不进 Dialog 的回调——白屏还是没白屏,全靠这两个事件分辨
      listeners: [
        {
          type: "load",
          listener: () => void appendPluginLog("[monitor] browser load fired"),
        },
        {
          type: "error",
          listener: () => void appendPluginLog("[monitor] browser error event"),
        },
      ],
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
