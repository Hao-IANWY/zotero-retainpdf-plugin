import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { OFFICIAL_LLM_BASE_URL, RetainPdfClient } from "../api";

/**
 * 实时通道:进度事件走 SSE(progress-events),终态判定以详情轮询为准
 * (10s 一拍,兼作 SSE 断线的文案兜底)。事件只推文案,不当状态机。
 */
const JOB_TIMEOUT_MS = 60 * 60 * 1000;
const TERMINAL_POLL_MS = 10000;

/** 插件本地日志:Zotero profile 下的 retainpdf-plugin.log,追加写+体积裁剪。 */
const LOG_FILE_NAME = "retainpdf-plugin.log";
const LOG_MAX_BYTES = 512 * 1024;

async function appendPluginLog(line: string): Promise<void> {
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

/**
 * 右键条目菜单:"使用 RetainPDF 翻译"。菜单项是最终交互入口,不换位置。
 */
export function registerTranslateMenuItem(win?: Window) {
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `zotero-itemmenu-${config.addonRef}-translate`,
    label: getString("menu-translate-label"),
    icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    commandListener: () => translateSelectedItems(),
  });
}

/** 选中条目里的 PDF 附件(路径 + 挂回目标父条目)。 */
interface PdfTarget {
  path: string;
  filename: string;
  parent: Zotero.Item;
}

/**
 * M1 主线:收集 → 校验 prefs → 逐文件 上传/建任务/轮询/下载/挂回。
 * 每个文件一行 ProgressWindow,阶段文案实时刷新。
 */
async function translateSelectedItems() {
  const targets = collectSelectedPdfTargets();
  const progress = new Zotero.ProgressWindow({ closeOnClick: true });
  progress.changeHeadline(config.addonName);
  progress.show();

  if (targets.length === 0) {
    progress.addLines(
      getString("menu-no-pdf"),
      `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    );
    progress.startCloseTimer(4000);
    return;
  }

  // 提交前一次性校验任务必备参数,缺了直接失败,不浪费一次上传
  const missing = missingTaskConfig();
  if (missing) {
    progress.addLines(
      getString("menu-fail-config", { args: { reason: missing } }),
      `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    );
    progress.startCloseTimer(8000);
    return;
  }

  const icon = `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`;
  let anyFailed = false;
  for (const target of targets) {
    const line = new progress.ItemProgress(icon, target.filename);
    try {
      const outcome = await translateOne(
        new RetainPdfClient(),
        target,
        (text, percent) => {
          line.setText(text);
          if (percent != null) line.setProgress(Math.round(percent));
        },
      );
      line.setText(getString("menu-done", { args: { name: target.filename } }));
      line.setProgress(100);
      // 成功也上报:网页端能看到「客户端已挂回」的完整闭环
      await outcome.client
        .clientReport(
          outcome.jobId,
          "attach",
          "info",
          `已挂回 ${target.filename}(mono+dual)`,
        )
        .catch(() => {});
    } catch (error) {
      anyFailed = true;
      const reason =
        error instanceof Error && error.message ? error.message : "unknown";
      line.setText(getString("menu-fail", { args: { reason } }));
      line.setIcon("chrome://zotero/skin/cross.png");
      // 后端的行动建议(如"检查 MinerU Token")进描述区,多个失败叠加可读
      const suggestion = (error as any)?.suggestion as string | undefined;
      if (suggestion) progress.addDescription(suggestion);
      // 三份留痕之一:本地日志(服务端上报由各环节自己发,这里兜底记一条)
      await appendPluginLog(`FAIL ${target.filename}: ${reason}`);
    }
  }
  // 全部成功才自动关窗;有失败时保留现场等用户看完手动关(closeOnClick)
  if (!anyFailed) progress.startCloseTimer(8000);
}

/**
 * 单文件全流程。SSE 事件驱动进度(消费纪律:只读 lane=main 的
 * stage_detail/progress,不用 message 关键词判断阶段),终态由详情轮询判定。
 * 返回 {client, jobId} 供调用方做完成上报。
 */
async function translateOne(
  client: RetainPdfClient,
  target: PdfTarget,
  onStage: (text: string, percent?: number) => void,
): Promise<{ client: RetainPdfClient; jobId: string }> {

  onStage(getString("menu-stage-uploading"));
  await appendPluginLog(`START ${target.filename}`);
  const uploadId = await client.uploadPdf(target.path, target.filename);

  const jobId = await client.createTranslationJob(buildJobPayload(uploadId));
  await appendPluginLog(`JOB ${jobId}`);
  await client
    .clientReport(jobId, "create", "info", `任务已创建: ${target.filename}`)
    .catch(() => {});

  let lastStageText = "";
  const emitStage = (text: string, percent?: number) => {
    if (!text || text === lastStageText) return;
    lastStageText = text;
    onStage(text, percent);
  };

  const job = await pollUntilDone(client, jobId, emitStage);
  if (job.status !== "succeeded") {
    // 失败主因取 failure.root_cause(后端人话),行动建议挂到 error.suggestion
    const error = new Error(
      job?.failure?.root_cause || job?.error || job.status,
    ) as Error & { suggestion?: string };
    error.suggestion = job?.failure?.suggestion;
    await appendPluginLog(`JOB-FAIL ${jobId}: ${error.message}`);
    throw error;
  }

  // mono(纯译文)取详情 actions.download_pdf;dual(双语对照)actions 里没有,
  // 走固定端点 /api/v1/jobs/{id}/pdf/side-by-side。mono 失败即任务失败;
  // dual 失败只少挂一个对照件,不拖垮整体。
  const actions = job.actions || {};
  await attachArtifact(
    client,
    target,
    "mono",
    actions.download_pdf?.url || `/api/v1/jobs/${jobId}/pdf`,
    jobId,
  );
  try {
    await attachArtifact(
      client,
      target,
      "dual",
      `/api/v1/jobs/${jobId}/pdf/side-by-side`,
      jobId,
    );
  } catch (error) {
    ztoolkit.log(`[M1] dual artifact skipped: ${error}`);
    await appendPluginLog(
      `dual skipped ${jobId}: ${error instanceof Error ? error.message : error}`,
    );
  }
  return { client, jobId };
}

/**
 * 挂回一个产物:直接 Zotero.Attachments.importFromURL——下载、写盘、入库
 * 全走 Zotero 官方代码路径。此前的手动路线(下载 arraybuffer + 临时文件 +
 * importFromFile)在 Zotero 10 上反复触雷:putContentsAsync 的二进制分支
 * (ArrayBuffer/Uint8Array 均被 nsIAsyncStreamCopier2.init 以 NS_ERROR_FAILURE
 * 拒绝),官方 importFromURL 无此问题。失败三份留痕:进度窗/本地日志/事件流。
 */
async function attachArtifact(
  client: RetainPdfClient,
  target: PdfTarget,
  suffix: string,
  url: string,
  jobId: string,
) {
  // 命名约定:忽略原始文献名(超长名会撞文件系统 255 字节上限),直接用
  // mono.pdf / dual.pdf——挂回的父条目本身就是文献上下文,名字无需重复。
  const fullUrl = url.startsWith("http")
    ? url
    : `${client.baseURLForArtifact(url)}`;
  try {
    await Zotero.Attachments.importFromURL({
      url: fullUrl,
      libraryID: target.parent.libraryID,
      parentItemID: target.parent.id as number,
      title: `${suffix}.pdf`,
      contentType: "application/pdf",
    } as any);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `挂回失败(${suffix}): ${detail}`;
    await appendPluginLog(`ERROR ${jobId} ${message}`);
    await client
      .clientReport(jobId, `attach-${suffix}`, "error", message)
      .catch(() => {});
    throw new Error(message);
  }
  await appendPluginLog(
    `attached ${jobId} ${suffix} under item ${target.parent.id}`,
  );
}

/**
 * 等待任务到终态。文案走 SSE(progress-events):事件到达即推,不再空转
 * 轮询事件端点。终态判定只认详情 status(10s 一拍)——契约明确事件文案
 * 与 percent 都不代表完成;这拍详情轮询同时兼作 SSE 断线时的文案兜底。
 */
async function pollUntilDone(
  client: RetainPdfClient,
  jobId: string,
  emitStage: (text: string, percent?: number) => void,
): Promise<any> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let ended = false;
  const stopWatch = client.watchProgressEvents(
    jobId,
    (event) => {
      // lane=main 优先;diagnostic 兜底(排队期只有诊断事件)
      if (event?.lane === "main" || event?.lane === "diagnostic") {
        emitStage(event.stage_detail, event.progress?.percent);
      }
    },
    () => {
      ended = true;
    },
  );
  try {
    while (true) {
      if (ended) {
        // SSE end 只当信号;终态事实仍以详情为准
        return await client.getJob(jobId);
      }
      await Zotero.Promise.delay(TERMINAL_POLL_MS);
      if (ended) continue; // delay 期间 end 已到,下一圈直接收
      const job = await client.getJob(jobId);
      if (["succeeded", "failed", "canceled"].includes(job?.status)) {
        return job;
      }
      emitStage(
        [job?.display_stage, job?.substage].filter(Boolean).join(" · "),
      );
      if (Date.now() > deadline) {
        throw new Error("job timeout");
      }
    }
  } finally {
    stopWatch();
  }
}

/**
 * 按契约(frontend_request_example §4)组装任务 payload。
 * 凭据/模型/并发全部来自 prefs(ADR 0009:随任务携带)。
 */
function buildJobPayload(uploadId: string): object {
  const ocrProvider = getPref("ocrProvider") === "paddle" ? "paddle" : "mineru";
  const ocr: Record<string, unknown> = { provider: ocrProvider };
  ocr[ocrProvider === "paddle" ? "paddle_token" : "mineru_token"] = getPref(
    ocrProvider === "paddle" ? "paddleToken" : "mineruToken",
  );

  const isCustom = getPref("llmApiMode") === "custom";
  const workers = parseInt(getPref("workers") as string, 10);

  return {
    workflow: "book",
    source: { upload_id: uploadId },
    ocr,
    translation: {
      base_url: isCustom ? getPref("llmBaseUrl") : OFFICIAL_LLM_BASE_URL,
      api_key: getPref("llmApiKey"),
      model: getPref("llmModel"),
      mode: "sci",
      math_mode: "direct_typst",
      ...(Number.isFinite(workers) && workers > 0 ? { workers } : {}),
    },
    render: { render_mode: "auto" },
  };
}

/** 创建任务的硬性字段(frontend_request_example §4.3)缺哪个报哪个。 */
function missingTaskConfig(): string | null {
  const ocrProvider = getPref("ocrProvider") === "paddle" ? "paddle" : "mineru";
  if (!getPref(ocrProvider === "paddle" ? "paddleToken" : "mineruToken")) {
    return `${ocrProvider} token`;
  }
  const isCustom = getPref("llmApiMode") === "custom";
  if (isCustom && !getPref("llmBaseUrl")) return "base_url";
  if (!getPref("llmApiKey")) return "api_key";
  if (!getPref("llmModel")) return "model";
  return null;
}

/**
 * 收集当前选中条目的 PDF 附件路径与父条目。
 *
 * Zotero 数据模型:条目(文献)→ 子条目(attachment,contentType=application/pdf)。
 * 只取第一层 PDF 附件;快照与链接附件都接受(getFilePathAsync 两者都能解析)。
 * 直接选中的 PDF 附件挂回其自身父条目。
 */
function collectSelectedPdfTargets(): PdfTarget[] {
  const items = Zotero.getActiveZoteroPane().getSelectedItems();
  const targets: PdfTarget[] = [];
  for (const item of items) {
    // 直接选中的 PDF 附件
    if (
      item.isAttachment() &&
      item.attachmentContentType === "application/pdf"
    ) {
      pushTarget(targets, item, item.parentItemID);
      continue;
    }
    // 常规条目:查其子附件
    const attachmentIDs = item.getAttachments?.() ?? [];
    for (const id of attachmentIDs) {
      const attachment = Zotero.Items.get(id);
      if (attachment?.attachmentContentType === "application/pdf") {
        pushTarget(targets, attachment, item.id);
      }
    }
  }
  return targets;
}

/** 路径可解析才入列;无父条目的孤儿附件没有挂回目标,静默跳过。 */
function pushTarget(
  targets: PdfTarget[],
  attachment: Zotero.Item,
  parentItemID: number | false | undefined,
) {
  // getFilePath 是同步 API:返回路径或 false(链接附件未解析时)
  const path = attachment.getFilePath();
  if (!path) return;
  const parent = parentItemID ? Zotero.Items.get(parentItemID) : undefined;
  if (!parent) return;
  targets.push({
    path,
    filename: path.split(/[\\/]/).pop() || "document.pdf",
    parent,
  });
}
