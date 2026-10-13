import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { OFFICIAL_LLM_BASE_URL } from "../api";

/**
 * 偏好页装配。表单值经 XHTML 的 `preference` 属性与 Zotero 偏好系统双向绑定,
 * 这里负责绑定给不了的几件事:
 * 1. 密钥框注入可见性切换按钮(眼睛图标)
 * 2. 分段控件(OCR 引擎 / LLM 供应商)的选中态与偏好读写
 * 3. 由选项驱动的字段行显隐(各引擎各显各的凭据行)
 * 4. 模型下拉的初始填充与 change 持久化、模型刷新按钮装配
 */

// Feather 风格线性图标:密文态显示 eye(点击后可查看),明文态显示 eye-off
const EYE_OPEN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const REFRESH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

const HTML_NS = "http://www.w3.org/1999/xhtml";

const prefElementId = (suffix: string) =>
  `zotero-prefpane-${config.addonRef}-${suffix}`;

export function registerPrefsScripts(win: Window) {
  const doc = win.document;

  // ---- 密钥框可见性切换 ----
  const secretContainers = doc.querySelectorAll(
    ".rp-secret",
  ) as unknown as Element[];
  for (const container of secretContainers) {
    const input = container.querySelector("input") as HTMLInputElement | null;
    if (!input || container.querySelector(".rp-icon-btn")) continue;

    const btn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
    btn.classList.add("rp-icon-btn");
    btn.type = "button";
    btn.innerHTML = EYE_OPEN_SVG;
    btn.title = getString("pref-show-key");
    btn.addEventListener("click", () => {
      // input 当前是密文 → 切明文;注意切换发生在 click 之前的状态判断
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      btn.innerHTML = reveal ? EYE_OFF_SVG : EYE_OPEN_SVG;
      btn.title = getString(reveal ? "pref-hide-key" : "pref-show-key");
    });
    container.appendChild(btn);
  }

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

  // 历史值 "official" 与缺省都归一到 deepseek 分支
  const llmApiMode = getPref("llmApiMode") === "custom" ? "custom" : "deepseek";
  const syncLlmRows = (mode: string) => {
    setRowVisible("llm-base-url-official-row", mode === "deepseek");
    setRowVisible("llm-base-url-custom-row", mode === "custom");
  };
  initSegment(doc, prefElementId("llm-mode"), llmApiMode, (value) => {
    setPref("llmApiMode", value);
    syncLlmRows(value);
  });
  syncLlmRows(llmApiMode);

  // ---- 模型下拉:初始只含已保存值(或提示项),完整列表靠刷新拉取 ----
  const modelSelect = doc.getElementById(
    prefElementId("llm-model"),
  ) as HTMLSelectElement | null;
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

  // ---- 模型刷新按钮:注入图标/提示,点击经 hooks 分发拉取 ----
  const refreshBtn = doc.getElementById(
    prefElementId("llm-models-refresh"),
  ) as HTMLButtonElement | null;
  if (refreshBtn && !refreshBtn.innerHTML) {
    refreshBtn.innerHTML = REFRESH_SVG;
    refreshBtn.title = getString("pref-models-refresh");
    refreshBtn.addEventListener("click", () => {
      (Zotero as any)[addon.data.config.addonInstance].hooks.onPrefsEvent(
        "fetchModels",
        { window: win },
      );
    });
  }
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
