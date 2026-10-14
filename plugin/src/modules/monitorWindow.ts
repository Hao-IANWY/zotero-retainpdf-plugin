import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { appendPluginLog } from "../utils/log";
import type { DialogHelper } from "zotero-plugin-toolkit";

/**
 * RetainPDF 监控台窗口(docs/ops/planning/zotero-monitor-window.md)。
 * 形态:ztoolkit.Dialog 非模态大窗内嵌 HTML <iframe> 直接加载监控台现网
 * HTML——插件不实现任何列表/详情 UI,监控台改版零跟进。web 容器同原点
 * 服务静态页与 /api/ 反代,页面内 fetch/SSE 行为与浏览器完全一致。
 *
 * 载体定案(2026-10-14):iframe 取代 XUL <browser>。Dialog 的窗口是
 * about:blank HTML 文档,XUL browser 在其中连踩两坑(默认 chrome 权限
 * 拒载远程 URL;flex 高度链塌缩归零)后仍白屏,frame loader 创建时机在
 * HTML 文档里不可靠。iframe 是 HTML 原生元素,零玄学。
 *
 * 入口:唯一入口 = 搜索栏右侧按钮(#zotero-items-toolbar 注入),
 * 菜单一律不挂。地址:监控台地址就是服务地址(web 入口同原点),不开放
 * 单独配置。
 *
 * 硬约束:iframe 导航注入不了自定义请求头,Cloudflare Access 公网形态
 * 此窗口天然不可用;v1 仅支持无边缘认证直连(本机/内网/tailscale)。
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

/** 唯一入口:搜索栏右侧按钮(老板钦定)。工具/右键菜单均不挂。 */
export function registerMonitorEntry(win: _ZoteroTypes.MainWindow) {
  const open = () => void openMonitorWindow();
  // 按钮注入 #zotero-items-toolbar(Zotero 7 条目工具栏,搜索框所在 hbox),
  // 紧贴搜索框右侧(insertBefore searchBox.nextSibling)——appendChild 在
  // Zotero 7.1+ 会落到堆叠模式切换按钮之后,偏离老板钦定位置。
  // 逐层回退防 Zotero 改版;逐窗口注入,按 id 去重。
  const doc = win.document;
  if (doc.getElementById(TOOLBAR_BUTTON_ID)) return;
  const anchor =
    doc.getElementById("zotero-items-toolbar") ??
    doc.getElementById("zotero-tb-search")?.parentElement ??
    doc.getElementById("zotero-toolbar-item-tree");
  if (!anchor) {
    void appendPluginLog(
      "[monitor] neither #zotero-items-toolbar nor fallback found, button skipped",
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
  const searchBox = doc.getElementById("zotero-tb-search");
  const before =
    searchBox && searchBox.parentElement === anchor
      ? searchBox.nextSibling
      : null;
  anchor.insertBefore(btn, before);
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
  // 载体用 HTML iframe 而非 XUL <browser>:Dialog 开的是 about:blank HTML
  // 文档,XUL browser 在其中连踩两坑(默认 chrome 权限拒载远程 URL →
  // type="content";flex 高度链塌缩 → vw/vh)后仍白屏——frame loader 的创建
  // 时机在 HTML 文档里不可靠。iframe 是 HTML 原生元素,在 chrome 文档里
  // 加载远程页面零玄学,better-notes 等插件的同构做法。
  const frameId = `${config.addonRef}-monitor-browser`;
  next.addCell(
    0,
    0,
    {
      tag: "iframe",
      namespace: "html",
      id: frameId,
      attributes: { src: `${root}/index.html` },
      styles: {
        width: "100vw",
        height: "100vh",
        border: "none",
        display: "block",
      },
      listeners: [
        {
          type: "load",
          listener: () => void appendPluginLog("[monitor] iframe load fired"),
        },
        {
          type: "error",
          listener: () => void appendPluginLog("[monitor] iframe error event"),
        },
      ],
    },
    true,
  );
  // 加载看门狗:15s 还没 load 就在日志里点名"卡死",和"加载了但白屏"区分开
  const watchdog = setTimeout(() => {
    void appendPluginLog("[monitor] iframe load watchdog expired (15s, no load)");
  }, 15000);
  next.setDialogData({
    loadCallback: () => {
      const d = next.window?.document;
      if (!d) return;
      // Dialog 的 about:blank 文档 html/body 无显式高度,100% 链会塌,
      // 补齐高度链;body 默认 margin 也要清掉,否则 vw/vh 撑出滚动条。
      const styleEl = d.createElement("style");
      styleEl.textContent = "html, body { height: 100%; margin: 0; padding: 0; }";
      (d.head ?? d.documentElement)?.appendChild(styleEl);
      const frame = d.getElementById(frameId);
      frame?.addEventListener("load", () => {
        clearTimeout(watchdog);
        void appendPluginLog("[monitor] iframe load fired (capture)");
      });
      void appendPluginLog("[monitor] window DOM ready, style injected");
    },
    // beforeUnload 时窗口尚在、元素仍可访问:此刻读几何最可靠
    beforeUnloadCallback: saveGeometry,
    unloadCallback: () => {
      clearTimeout(watchdog);
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
