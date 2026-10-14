import { getPref } from "./utils/prefs";

/** LLM「官方」选项的预置端点(DeepSeek),只读展示,不进入偏好存储。 */
export const OFFICIAL_LLM_BASE_URL = "https://api.deepseek.com/v1";

/**
 * 网络层失败的兜底描述。Zotero.HTTP.request 拒绝时抛的不一定是带 message 的
 * Error(可能是 XHR 状态对象/ ProgressEvent),笼统的 "network error" 让内网
 * 地址走代理这类问题无从排查——把 name/status/code 等能挖的都挖出来。
 */
function describeNetError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null) {
    const anyErr = error as Record<string, unknown>;
    const bits = [
      typeof anyErr.name === "string" ? anyErr.name : "",
      anyErr.status != null ? `status=${anyErr.status}` : "",
      anyErr.code != null ? `code=${anyErr.code}` : "",
    ].filter(Boolean);
    if (bits.length) return `network error (${bits.join(" ")})`;
  }
  return `network error (${String(error)})`;
}

/**
 * Zotero.HTTP 对非 2xx 直接抛 UnexpectedStatusException,后端信封
 * {code,message} 在 xmlhttp.responseText 里——把后端人话带出来
 * (如私网策略 400 的 "private targets require explicit opt-in"),
 * 而不是只报个状态码让用户猜。
 */
function describeHttpFailure(error: unknown): string {
  const xmlhttp = (error as any)?.xmlhttp;
  const status = xmlhttp?.status;
  const responseText = xmlhttp?.responseText;
  if (typeof responseText === "string" && responseText.trim()) {
    try {
      const body = JSON.parse(responseText);
      if (body?.message) return `HTTP ${status}: ${body.message}`;
    } catch {
      // 非 JSON 响应体,落回通用描述
    }
  }
  return describeNetError(error);
}

/**
 * RetainPDF 服务端 API 客户端。
 *
 * 消费纪律(与 docs/api/README 对齐):
 * - 服务端不启用访问密钥,请求不带 X-API-Key
 * - 任务进度只读 display_stage/substage,主线进度只读 lane=main
 */
export class RetainPdfClient {
  private baseURL: string;

  constructor(baseURL?: string) {
    this.baseURL = (baseURL ?? getPref("serverBaseURL")).replace(/\/+$/, "");
  }

  /**
   * GET /health —— 偏好页"检查连接"与未来菜单探测共用。
   * 返回服务端版本号,失败抛出带原因的 Error。
   */
  async checkHealth(timeoutMs = 5000): Promise<string> {
    const url = `${this.baseURL}/health`;
    try {
      const response = await Zotero.HTTP.request("GET", url, {
        timeout: timeoutMs,
        responseType: "json",
      });
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      const version = response.response?.version ?? "";
      return version;
    } catch (error) {
      throw new Error(describeHttpFailure(error));
    }
  }

  /**
   * POST /api/v1/providers/{provider}/validate-token —— OCR 凭据探针。
   * 成功返回后端 summary 文案,失败抛出带原因的 Error。
   */
  async validateOcrToken(
    provider: "paddle" | "mineru",
    token: string,
  ): Promise<string> {
    const payload =
      provider === "paddle" ? { paddle_token: token } : { mineru_token: token };
    return this.probe(`/api/v1/providers/${provider}/validate-token`, payload);
  }

  /**
   * POST /api/v1/providers/deepseek/validate-token —— LLM 凭据探针。
   * 探针接受自定义 OpenAI 兼容端点(base_url + model),DeepSeek 与自定义供应商共用。
   */
  async validateLlmCredential(
    baseUrl: string,
    apiKey: string,
    model: string,
  ): Promise<string> {
    return this.probe("/api/v1/providers/deepseek/validate-token", {
      api_key: apiKey,
      base_url: baseUrl,
      model,
    });
  }

  /**
   * 探针公共请求。响应外层 { code, message, data },结果看 data.ok。
   * 后端探针自身超时 20s,这里留 30s 与网页端对齐。
   */
  private async probe(path: string, payload: object): Promise<string> {
    const url = `${this.baseURL}${path}`;
    let body: any;
    try {
      const response = await Zotero.HTTP.request("POST", url, {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        responseType: "json",
        timeout: 30000,
      });
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      body = response.response;
    } catch (error) {
      throw new Error(describeHttpFailure(error));
    }
    if (body?.code !== 0) {
      throw new Error(body?.message || `code ${body?.code}`);
    }
    const data = body.data;
    if (!data?.ok) {
      throw new Error(data?.summary || data?.operator_hint || "rejected");
    }
    return data.summary || "";
  }

  /**
   * GET {baseUrl}/models —— OpenAI 兼容的模型列表,插件直连供应商
   * (不经后端代理),DeepSeek 与自定义供应商通用。返回排序后的模型 id 列表。
   */
  async listModels(baseUrl: string, apiKey: string): Promise<string[]> {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    let body: any;
    try {
      const response = await Zotero.HTTP.request("GET", url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        responseType: "json",
        timeout: 15000,
      });
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      body = response.response;
    } catch (error) {
      throw new Error(describeHttpFailure(error));
    }
    const list = Array.isArray(body?.data) ? body.data : [];
    const ids = list
      .map((m: any) => m?.id)
      .filter((id: any): id is string => typeof id === "string" && !!id);
    if (!ids.length) {
      throw new Error("empty model list");
    }
    return ids.sort();
  }

  /**
   * POST /api/v1/uploads —— multipart 上传原 PDF,返回 upload_id。
   * 读文件与发送都走 chrome window 的 fetch:fetch(file://) 取 Blob 二进制
   * 安全,fetch+FormData 是 multipart 的标准组合——Zotero.HTTP.request 的
   * body 契约只收 string|Uint8Array,传 FormData 是未定义行为(实测会挂)。
   * FormData/Blob/AbortController 在插件沙箱不存在,统一从主窗口借。
   */
  async uploadPdf(filePath: string, filename: string): Promise<string> {
    const win = Zotero.getMainWindow() as any;
    const fileUrl = Zotero.File.pathToFileURI(filePath);

    let blob: Blob;
    try {
      const fileResp = await win.fetch(fileUrl);
      if (!fileResp.ok) throw new Error(`read file HTTP ${fileResp.status}`);
      blob = await fileResp.blob();
    } catch (error) {
      throw new Error(
        `read source failed: ${error instanceof Error ? error.message : error}`,
      );
    }

    const formData = new win.FormData();
    formData.append("file", blob, filename);

    const controller = new win.AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);
    let resp: any;
    try {
      resp = await win.fetch(`${this.baseURL}/api/v1/uploads`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        `upload failed: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const body = await resp.json().catch(() => null);
    if (!resp.ok || body?.code !== 0) {
      throw new Error(body?.message || `HTTP ${resp.status}`);
    }
    const uploadId = body?.data?.upload_id;
    if (!uploadId) throw new Error("upload_id missing");
    return uploadId;
  }

  /**
   * POST /api/v1/jobs —— 创建翻译任务,payload 结构由调用方按契约
   * (docs/api + frontend_request_example)组装,这里只透传。返回 job_id。
   */
  async createTranslationJob(payload: object): Promise<string> {
    const response = await Zotero.HTTP.request(
      "POST",
      `${this.baseURL}/api/v1/jobs`,
      {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        responseType: "json",
        timeout: 30000,
      },
    );
    const body = this.envelope(response);
    const jobId = body?.data?.job_id;
    if (!jobId) throw new Error("job_id missing");
    return jobId as string;
  }

  /** GET /api/v1/jobs/{job_id} —— 任务详情(status/display_stage/substage)。 */
  async getJob(jobId: string): Promise<any> {
    const response = await Zotero.HTTP.request(
      "GET",
      `${this.baseURL}/api/v1/jobs/${jobId}`,
      { responseType: "json", timeout: 15000 },
    );
    return this.envelope(response)?.data;
  }

  /**
   * 下载产物到本地路径。url 取任务详情 actions.* 里的相对地址
   * (以 / 开头拼 baseURL,完整 URL 直接用)。下载(HTTP)与写盘分步抛错——
   * 曾有「HTTP 200 全量到手、写盘 NS_ERROR_FAILURE」被笼统标成下载失败的案例。
   */
  async downloadArtifact(url: string, targetPath: string): Promise<void> {
    const fullUrl = url.startsWith("http") ? url : `${this.baseURL}${url}`;
    const response = await Zotero.HTTP.request("GET", fullUrl, {
      responseType: "arraybuffer",
      timeout: 300000,
    });
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }
    try {
      // ArrayBuffer 会被底层 NetUtil.asyncCopy 拒绝(nsIAsyncStreamCopier2.init
      // NS_ERROR_FAILURE)——putContentsAsync 的非字符串路径要求可包装成
      // nsIInputStream 的类型,Zotero 官方保存路径统一传 Uint8Array。
      await Zotero.File.putContentsAsync(
        targetPath,
        new Uint8Array(response.response) as any,
      );
    } catch (error) {
      throw new Error(
        `写入 ${targetPath} 失败: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * GET /api/v1/jobs/{job_id}/events —— 事件列表(默认返回最新窗口)。
   * 用于进度文案:事件带 stage_detail(人话)与 progress.percent,
   * 客户端按 seq 去重消费。终态判定不依赖事件,以详情轮询为准。
   */
  async listJobEvents(jobId: string, limit = 50): Promise<any[]> {
    const response = await Zotero.HTTP.request(
      "GET",
      `${this.baseURL}/api/v1/jobs/${jobId}/events?limit=${limit}`,
      { responseType: "json", timeout: 15000 },
    );
    return this.envelope(response)?.data?.items ?? [];
  }

  /**
   * GET /api/v1/jobs/{job_id}/progress-events —— 进度事件 SSE 流。
   * progress 事件带 stage_detail 人话与 progress.percent;终态时服务端发
   * 命名事件 end 后关流(调用方须在 end 时 close)。返回关闭函数。
   * EventSource 断线自动重连;老后端无此端点时 onerror 反复触发,
   * 调用方以详情轮询兜底,不依赖流的存活。
   */
  watchProgressEvents(
    jobId: string,
    onProgress: (event: any) => void,
    onEnd: () => void,
  ): () => void {
    const win = Zotero.getMainWindow() as any;
    const es = new win.EventSource(
      `${this.baseURL}/api/v1/jobs/${jobId}/progress-events`,
    );
    es.addEventListener("progress", (e: any) => {
      try {
        onProgress(JSON.parse(e.data));
      } catch {
        // 非 JSON 帧忽略
      }
    });
    es.addEventListener("end", onEnd);
    return () => es.close();
  }

  /**
   * POST /api/v1/jobs/{job_id}/client-report —— 客户端结果上报。
   * 把插件侧环节(下载/挂回)的结果写回服务端事件流,网页详情页可见。
   * 尽力而为:失败静默,绝不阻塞主流程。
   */
  async clientReport(
    jobId: string,
    stage: string,
    level: "info" | "error",
    message: string,
  ): Promise<void> {
    try {
      await Zotero.HTTP.request(
        "POST",
        `${this.baseURL}/api/v1/jobs/${jobId}/client-report`,
        {
          body: JSON.stringify({ stage, level, message }),
          headers: { "Content-Type": "application/json" },
          responseType: "json",
          timeout: 10000,
        },
      );
    } catch {
      // 上报失败不影响主流程
    }
  }

  /** 产物相对地址(以 / 开头)拼成完整 URL;绝对地址原样返回。 */
  baseURLForArtifact(url: string): string {
    return url.startsWith("http") ? url : `${this.baseURL}${url}`;
  }

  /** 统一的外层 {code,message,data} 信封校验,非 0 抛错。 */
  private envelope(response: any): any {
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = response.response;
    if (body?.code !== 0) {
      throw new Error(body?.message || `code ${body?.code}`);
    }
    return body;
  }

  /** 后续里程碑:取消任务、失败重试。 */
}
