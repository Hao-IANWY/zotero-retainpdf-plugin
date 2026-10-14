import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { OFFICIAL_LLM_BASE_URL } from "../api";

/**
 * 偏好页装配。表单值经 XHTML 的 `preference` 属性与 Zotero 偏好系统双向绑定,
 * 这里负责绑定给不了的几件事:
 * 1. 分段控件(OCR 引擎 / LLM 供应商)的选中态与偏好读写
 * 2. 由选项驱动的字段行显隐(各引擎各显各的凭据行)
 * 3. 模型下拉的初始填充与 change 持久化、模型刷新按钮装配、开页自动拉取
 * 密钥框一律明文(2026-10 老板拍板),不再注入任何显隐切换按钮。
 */

// Feather 风格线性图标:模型列表刷新
// xmlns 必须显式声明:偏好面板是 XML(XHTML) 文档,innerHTML 走 XML 解析,
// 缺 xmlns 的 <svg> 会落入 XHTML 命名空间而非 SVG 命名空间——元素在但不渲染。
const REFRESH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

const HTML_NS = "http://www.w3.org/1999/xhtml";

const prefElementId = (suffix: string) =>
  `zotero-prefpane-${config.addonRef}-${suffix}`;

export function registerPrefsScripts(win: Window) {
  const doc = win.document;

  const setRowVisible = (suffix: string, visible: boolean) => {
    doc
      .getElementById(prefElementId(suffix))
      ?.toggleAttribute("hidden", !visible);
  };

  // ---- OCR 引擎分段:PaddleOCR / MinerU 各显各的凭据行 ----
  const ocrProvider = getPref("ocrProvider") || "mineru";
  const syncOcrRows = (provider: string) => {
    setRowVisible("paddle-token-row", provider === "paddle");
    setRowVisible("mineru-token-row", provider === "mineru");
  };
  initSegment(doc, prefElementId("ocr-provider"), ocrProvider, (value) => {
    setPref("ocrProvider", value);
    syncOcrRows(value);
  });
  syncOcrRows(ocrProvider);

  // ---- LLM 供应商分段:DeepSeek 预置只读地址,自定义走偏好绑定的可编辑框 ----
  const officialInput = doc.getElementById(
    prefElementId("llm-base-url-official"),
  ) as HTMLInputElement | null;
  if (officialInput) officialInput.value = OFFICIAL_LLM_BASE_URL;

  const baseUrlInput = doc.getElementById(
    prefElementId("llm-base-url"),
  ) as HTMLInputElement | null;
  const apiKeyInput = doc.getElementById(
    prefElementId("llm-api-key"),
  ) as HTMLInputElement | null;
  const modelSelect = doc.getElementById(
    prefElementId("llm-model"),
  ) as HTMLSelectElement | null;
  const workersInput = doc.getElementById(
    prefElementId("workers"),
  ) as HTMLInputElement | null;

  // 历史值 "official" 与缺省都归一到 deepseek 分支
  const llmApiMode = getPref("llmApiMode") === "custom" ? "custom" : "deepseek";
  const syncLlmRows = (mode: string) => {
    setRowVisible("llm-base-url-official-row", mode === "deepseek");
    setRowVisible("llm-base-url-custom-row", mode === "custom");
  };

  // 各供应商配置分槽存档(含并发数):切换时先把当前值压回旧供应商槽位,
  // 再从新供应商槽位恢复(凭据/模型从未配置过则恢复为空,呈现未输入态;
  // 并发数空槽回落默认 5,保证数字框不空)。生效键
  // (llmBaseUrl/llmApiKey/llmModel/workers)仍是任务发起与连接检查的唯一读取口。
  initSegment(doc, prefElementId("llm-mode"), llmApiMode, (value) => {
    const prev = getPref("llmApiMode") === "custom" ? "custom" : "deepseek";
    // 读 DOM 而非偏好:输入框的绑定写回发生在失焦时,点击瞬间偏好可能滞后
    const current = {
      baseUrl: baseUrlInput?.value ?? "",
      apiKey: apiKeyInput?.value ?? "",
      model: modelSelect?.value ?? "",
      workers: workersInput?.value ?? "",
    };
    if (prev === "deepseek") {
      setPref("llmApiKeyDeepseek", current.apiKey);
      setPref("llmModelDeepseek", current.model);
      setPref("workersDeepseek", current.workers || "5");
    } else {
      setPref("llmBaseUrlCustom", current.baseUrl);
      setPref("llmApiKeyCustom", current.apiKey);
      setPref("llmModelCustom", current.model);
      setPref("workersCustom", current.workers || "5");
    }
    const restored = {
      baseUrl: value === "custom" ? getPref("llmBaseUrlCustom") || "" : "",
      apiKey:
        (value === "custom"
          ? getPref("llmApiKeyCustom")
          : getPref("llmApiKeyDeepseek")) || "",
      model:
        (value === "custom"
          ? getPref("llmModelCustom")
          : getPref("llmModelDeepseek")) || "",
      workers:
        (value === "custom"
          ? getPref("workersCustom")
          : getPref("workersDeepseek")) || "5",
    };
    if (apiKeyInput) apiKeyInput.value = restored.apiKey;
    if (baseUrlInput) baseUrlInput.value = restored.baseUrl;
    if (workersInput) workersInput.value = restored.workers;
    setPref("llmApiKey", restored.apiKey);
    setPref("llmBaseUrl", restored.baseUrl);
    setPref("llmModel", restored.model);
    setPref("workers", restored.workers);
    if (modelSelect) {
      fillModelOptions(
        modelSelect,
        restored.model ? [restored.model] : [],
        restored.model,
        getString("pref-models-empty"),
      );
    }
    setPref("llmApiMode", value);
    syncLlmRows(value);
    // 旧供应商的检查结论对新配置不成立,清掉避免误导
    doc
      .getElementById(prefElementId("check-result-llm"))
      ?.toggleAttribute("hidden", true);
  });
  syncLlmRows(llmApiMode);

  // ---- 模型下拉:初始只含已保存值(或提示项),完整列表靠刷新拉取 ----
  if (modelSelect) {
    const current = (getPref("llmModel") as string) || "";
    fillModelOptions(
      modelSelect,
      current ? [current] : [],
      current,
      getString("pref-models-empty"),
    );
    modelSelect.addEventListener("change", () => {
      setPref("llmModel", modelSelect.value);
    });
  }

  // ---- 模型刷新:拉取动作的统一入口,刷新按钮与开页自动触发共用 ----
  // onPrefsEvent 是 async:兜住编程性异常,避免 unhandled rejection 被静默吞掉
  const triggerFetchModels = () => {
    const pending = (Zotero as any)[
      addon.data.config.addonInstance
    ].hooks.onPrefsEvent("fetchModels", {
      window: win,
    }) as Promise<void> | undefined;
    pending?.catch((error) =>
      ztoolkit.log(`[prefs] fetch models crashed: ${error}`),
    );
  };

  const refreshBtn = doc.getElementById(
    prefElementId("llm-models-refresh"),
  ) as HTMLButtonElement | null;
  if (refreshBtn && !refreshBtn.innerHTML) {
    refreshBtn.innerHTML = REFRESH_SVG;
    refreshBtn.title = getString("pref-models-refresh");
    refreshBtn.addEventListener("click", triggerFetchModels);
  }

  // 开页时凭据齐备就自动拉一次:下拉初始填充只有已保存值,
  // 不主动拉就永远只有一个选项,观感等于"模型选择不可用"
  const initialApiKey =
    apiKeyInput?.value || (getPref("llmApiKey") as string) || "";
  if (initialApiKey) triggerFetchModels();
}

/**
 * 填充模型下拉。models 为空时显示单个禁用提示项(emptyHint);
 * 已保存值不在新列表中时保留为额外项,避免用户配置被静默吞掉。
 * hooks 的 fetchModels 与本模块的初始化共用。
 */
export function fillModelOptions(
  select: HTMLSelectElement,
  models: string[],
  selected: string,
  emptyHint = "",
) {
  const doc = select.ownerDocument as Document;
  select.innerHTML = "";
  if (!models.length) {
    const opt = doc.createElementNS(HTML_NS, "option") as HTMLOptionElement;
    opt.value = "";
    opt.textContent = emptyHint;
    opt.disabled = true;
    select.appendChild(opt);
    select.value = "";
    return;
  }
  const all =
    selected && !models.includes(selected) ? [selected, ...models] : models;
  for (const id of all) {
    const opt = doc.createElementNS(HTML_NS, "option") as HTMLOptionElement;
    opt.value = id;
    opt.textContent = id;
    select.appendChild(opt);
  }
  select.value = selected && all.includes(selected) ? selected : all[0];
}

/**
 * 分段控件(role=radiogroup 的按钮组)初始化:回填选中态并接管点击。
 * 选中态用 aria-checked 表达,样式钩子与无障碍语义合一。
 */
function initSegment(
  doc: Document,
  elementId: string,
  initial: string,
  onSelect: (value: string) => void,
) {
  const group = doc.getElementById(elementId);
  if (!group) return;
  const items = Array.from(
    group.querySelectorAll(".rp-segment-item"),
  ) as HTMLButtonElement[];
  const sync = (value: string) => {
    for (const item of items) {
      item.setAttribute("aria-checked", String(item.dataset.value === value));
    }
  };
  sync(initial);
  for (const item of items) {
    item.addEventListener("click", () => {
      const value = item.dataset.value;
      if (!value) return;
      sync(value);
      onSelect(value);
    });
  }
}
