import { getString, initLocale } from "./utils/locale";
import { getPref, setPref } from "./utils/prefs";
import { appendPluginLog } from "./utils/log";
import {
  fillModelOptions,
  registerPrefsScripts,
} from "./modules/preferenceScript";
import { registerTranslateMenuItem } from "./modules/translateMenu";
import {
  closeDashboardWindow,
  registerDashboardEntry,
  removeDashboardEntry,
} from "./modules/dashboardWindow";
import { createZToolkit } from "./utils/ztoolkit";
import { OFFICIAL_LLM_BASE_URL, RetainPdfClient } from "./api";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // 注册偏好面板：不调用这步,Zotero 设置里不会出现本插件的入口。
  // 样式表必须经 stylesheets 参数注入——pane 文档不会处理 linkset 里的
  // stylesheet link(那里只有 localization link 会被加载)。
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: `${rootURI}content/preferences.xhtml`,
    stylesheets: [
      `${rootURI}content/ui/tokens.css`,
      `${rootURI}content/preferences.css`,
    ],
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-addon.ftl`,
  );

  registerTranslateMenuItem(win);
  registerDashboardEntry(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  removeDashboardEntry(win);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  closeDashboardWindow();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Preference UI events dispatcher.
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    case "checkConnection":
      await checkConnection(data.window as Window);
      break;
    case "checkOcr":
      await checkOcr(data.window as Window);
      break;
    case "checkLlm":
      await checkLlm(data.window as Window);
      break;
    case "fetchModels":
      await fetchModels(data.window as Window);
      break;
    default:
      return;
  }
}

/** 检查按钮恢复原样的延迟:结果在按钮上停留片刻后回到默认"检查连接"。 */
const CHECK_BTN_RESET_MS = 2500;
const checkBtnResetTimers: Record<string, ReturnType<typeof setTimeout>> = {};

/**
 * 检查反馈双通道:
 * - 状态行(卡片头部下方,data-state 着色,持久显示结果详情)
 * - 按钮自身状态机(检查中禁用 → 成功绿 / 失败红,2.5s 后恢复默认)
 * 模型拉取等非"检查"动作只走 setStatusLine,不惊动检查按钮。
 */
function setStatusLine(
  win: Window,
  group: "server" | "ocr" | "llm",
  state: "checking" | "ok" | "fail",
  text: string,
) {
  const prefId = (suffix: string) =>
    `zotero-prefpane-${addon.data.config.addonRef}-${suffix}`;
  const resultEl = win.document.getElementById(prefId(`check-result-${group}`));
  if (resultEl) {
    resultEl.removeAttribute("hidden");
    resultEl.setAttribute("data-state", state);
    resultEl.textContent = text;
  }
}

function setCheckState(
  win: Window,
  group: "server" | "ocr" | "llm",
  state: "checking" | "ok" | "fail",
  text: string,
) {
  const prefId = (suffix: string) =>
    `zotero-prefpane-${addon.data.config.addonRef}-${suffix}`;
  setStatusLine(win, group, state, text);
  const btn = win.document.getElementById(prefId(`check-${group}`)) as
    | (HTMLElement & { disabled: boolean })
    | null;
  if (!btn) return;
  clearTimeout(checkBtnResetTimers[group]);
  btn.setAttribute("data-state", state);
  btn.disabled = state === "checking";
  const labelKey =
    state === "checking"
      ? "pref-checking"
      : state === "ok"
        ? "pref-verify-ok"
        : "pref-btn-fail";
  btn.setAttribute("label", getString(labelKey));
  if (state !== "checking") {
    checkBtnResetTimers[group] = setTimeout(() => {
      btn.removeAttribute("data-state");
      btn.disabled = false;
      btn.setAttribute("label", getString("pref-check"));
    }, CHECK_BTN_RESET_MS);
  }
}

const errorReason = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "unknown";

/** 检查失败双通道之外再落一份插件日志:状态行会随界面关闭消失,日志可回传定位。 */
function logCheckFail(group: string, error: unknown) {
  void appendPluginLog(`[prefs] check ${group} failed: ${errorReason(error)}`);
}

async function checkConnection(win: Window) {
  setCheckState(win, "server", "checking", getString("pref-checking"));
  try {
    await new RetainPdfClient().checkHealth();
    setCheckState(win, "server", "ok", getString("pref-verify-ok"));
  } catch (error) {
    logCheckFail("server", error);
    setCheckState(
      win,
      "server",
      "fail",
      getString("pref-check-fail", { args: { reason: errorReason(error) } }),
    );
  }
}

async function checkOcr(win: Window) {
  const provider = getPref("ocrProvider") === "paddle" ? "paddle" : "mineru";
  const token = getPref(
    provider === "paddle" ? "paddleToken" : "mineruToken",
  ) as string;
  setCheckState(win, "ocr", "checking", getString("pref-checking"));
  if (!token) {
    setCheckState(win, "ocr", "fail", getString("pref-verify-empty"));
    return;
  }
  try {
    await new RetainPdfClient().validateOcrToken(provider, token);
    setCheckState(win, "ocr", "ok", getString("pref-verify-ok"));
  } catch (error) {
    setCheckState(
      win,
      "ocr",
      "fail",
      getString("pref-verify-fail", { args: { reason: errorReason(error) } }),
    );
  }
}

async function checkLlm(win: Window) {
  const isCustom = getPref("llmApiMode") === "custom";
  const baseUrl = isCustom ? getPref("llmBaseUrl") : OFFICIAL_LLM_BASE_URL;
  const apiKey = getPref("llmApiKey") as string;
  const model = getPref("llmModel") as string;
  setCheckState(win, "llm", "checking", getString("pref-checking"));
  if (!apiKey || !baseUrl) {
    setCheckState(win, "llm", "fail", getString("pref-verify-empty"));
    return;
  }
  try {
    await new RetainPdfClient().validateLlmCredential(baseUrl, apiKey, model);
    setCheckState(win, "llm", "ok", getString("pref-verify-ok"));
    // 凭证有效后顺手拉取模型列表,用户无需再点一次刷新
    await fetchModels(win);
  } catch (error) {
    logCheckFail("llm", error);
    setCheckState(
      win,
      "llm",
      "fail",
      getString("pref-verify-fail", { args: { reason: errorReason(error) } }),
    );
  }
}

/**
 * 拉取供应商可用模型填充下拉。此前失败原因只进日志(生产 console 关闭),
 * 下拉里只有提示项文案微变,用户观感就是"点了没效果"——现在把成败与
 * 原因都写上 LLM 状态行,失败时老板能直接把文案发回来定位。
 */
async function fetchModels(win: Window) {
  const doc = win.document;
  const prefId = (suffix: string) =>
    `zotero-prefpane-${addon.data.config.addonRef}-${suffix}`;
  const selectEl = doc.getElementById(
    prefId("llm-model"),
  ) as HTMLSelectElement | null;
  const refreshBtn = doc.getElementById(prefId("llm-models-refresh"));
  if (!selectEl || !refreshBtn) return;

  // 优先读输入框现值:preference 绑定写回发生在失焦时,点击瞬间偏好可能滞后
  const isCustom = getPref("llmApiMode") === "custom";
  const baseUrl = (
    (isCustom
      ? (doc.getElementById(prefId("llm-base-url")) as HTMLInputElement | null)
          ?.value || (getPref("llmBaseUrl") as string)
      : OFFICIAL_LLM_BASE_URL) || ""
  ).replace(/\/+$/, "");
  const apiKey =
    (doc.getElementById(prefId("llm-api-key")) as HTMLInputElement | null)
      ?.value ||
    (getPref("llmApiKey") as string) ||
    "";
  if (!baseUrl || !apiKey) {
    fillModelOptions(selectEl, [], "", getString("pref-models-need-key"));
    return;
  }

  refreshBtn.setAttribute("data-state", "loading");
  selectEl.disabled = true;
  fillModelOptions(selectEl, [], "", getString("pref-models-loading"));
  try {
    const models = await new RetainPdfClient().listModels(baseUrl, apiKey);
    const current = getPref("llmModel") as string;
    fillModelOptions(selectEl, models, current);
    if (selectEl.value !== current) {
      // 已保存的模型不在新列表中时,回落到第一项并固化
      setPref("llmModel", selectEl.value);
    }
    setStatusLine(
      win,
      "llm",
      "ok",
      getString("pref-models-ok", { args: { count: models.length } }),
    );
  } catch (error) {
    logCheckFail("models", error);
    ztoolkit.log(`[prefs] fetch models failed: ${errorReason(error)}`);
    fillModelOptions(selectEl, [], "", getString("pref-models-fail"));
    setStatusLine(
      win,
      "llm",
      "fail",
      getString("pref-check-fail", { args: { reason: errorReason(error) } }),
    );
  } finally {
    refreshBtn.removeAttribute("data-state");
    selectEl.disabled = false;
  }
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onPrefsEvent,
};
