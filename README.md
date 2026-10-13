# RetainPDF：PDF 保留排版翻译工具

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a> · <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <img src="resources/brand/RetainPDF-github.svg" alt="RetainPDF" width="320" />
</p>

RetainPDF 是目前唯一面向图片型 / 扫描版 PDF、支持保留排版翻译的开源项目，翻译与排版效果对标甚至超过同类商业产品。

自研字体排版算法，支持复杂公式与多栏论文的版式还原。扫描 PDF 翻译、PDF 结构优化、代码保护、自定义翻译策略和开放 API，一并支持。

翻译系统同样自研，针对跨栏、跨页、断句和段落续接等 PDF 常见难题做了专门处理：先恢复完整语义单元，再进行翻译，避免逐框翻译造成的上下文割裂。

**在行内公式部分 RetainPDF 的断层领先：翻译后仍能稳定保留公式本体、前后文关系与行内排版，这是其他开源 PDF 翻译项目目前做不到的。**

代码、API 与部署方式全部开放，支持自部署和二次开发。

核心能力对比：

| 项目 | 扫描型 PDF | 复杂行内公式 | 代码不误翻 | 表格控制 | 自定义翻译策略 | 排版保留 | PDF 压缩优化 | API 自动化 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDFMathTranslate | ❌ | ❌ | ❌ | 弱 | 弱 | 一般 | 一般 | ✅ |
| PolyglotPDF | ❌ | ❌ | ❌ | 弱 | 弱 | 一般 | 一般 | ✅ |
| Doc2X | ✅ | ✅ | ❌ | 中 | 弱 | 强 | 弱 | ❌ 不开放 |
| RetainPDF | ✅ | ✅ 强保留 | ✅ | ✅ 可开关 | ✅ 可按规则配置 | 强 | ✅ 持续优化 | ✅ |

## 核心特色

排版与公式之外，RetainPDF 在**翻译工程化**上同样下足了功夫：

### 🔌 Zotero 深度集成

装上[插件](https://github.com/Hao-IANWY/zotero-retainpdf-plugin/releases/latest)后，文献管理器就是翻译入口：右键条目 → 一键翻译 → 译文自动挂回原条目（`mono.pdf` 纯译文 + `dual.pdf` 双语对照）。偏好面板内可切换 OCR 引擎（MinerU / PaddleOCR）、选择 LLM 供应商（DeepSeek 预置或任意 OpenAI 兼容端点，模型列表自动发现）、一键检测连接。插件经 GitHub Releases 在线更新。

### 📡 SSE 实时事件流

任务进度走服务端推送而非轮询：网页详情页与 Zotero 进度窗共享同一套事件流（`/progress-events`），阶段文案与百分比到达即显；另有译文段落流（`/live-events`）支撑边翻边看。断线自动降级轮询，终态由任务状态唯一裁决——事件只是展示，不是状态机。

### 🩺 失败可诊断到最后一公里

失败原因不给你一串堆栈：服务端输出人话根因与修复建议（"API Key 无效、过期或权限不足"级别的文案），AI 诊断自动归类未知失败；更独特的是**客户端断链上报**——Zotero 插件把下载、挂回等本地环节的结果写回服务端事件流，"服务端翻译成功但本地挂回失败"这类问题在网页端直接可见，不用翻本地日志。

### 🔐 凭据不落盘

凭据随任务携带、响应不回显、日志自动脱敏；Zotero 侧不持久化任何密钥，网页端密钥仅存于服务端凭据库。清空历史是真删（任务记录 + 磁盘产物级联，源 PDF 保留）。

### ⏱️ 工程级可靠性

每个任务带双看门狗（总时长上限 + 无输出超时），挂死进程会被精确处决并留下失败原因；OCR 结果按文档缓存复用——翻译失败重试不再重跑 OCR、不重复花钱。

## 产品界面

网页端聚焦任务进度：任务经开放 API 提交（自研调用、脚本或 [Zotero 插件](plugin/)），在网页上集中查看执行状态与产物。

### 任务列表

按 运行 / 排队 / 失败 / 完成 分组集中查看全部任务，行内进度与取消/重试。

<p align="center">
  <img src="resources/brand/readme-gallery/product/task-list.png" alt="RetainPDF 任务列表" width="1000" />
</p>

### 任务详情

单任务的阶段进度、失败诊断、事件时间线与产物下载。

<p align="center">
  <img src="resources/brand/readme-gallery/product/task-detail.png" alt="RetainPDF 任务详情" width="1000" />
</p>

## 翻译效果

SCI 论文、图片型 / 扫描版 PDF 与图书教材的原文—译文对照样例：

<p align="center">
  <img src="resources/brand/readme-gallery/translation-examples.webp" alt="RetainPDF SCI 论文、扫描 PDF 与图书教材翻译效果合集" width="1000" />
</p>

<p align="center"><sub>第一行：SCI 论文 · 第二行：扫描与公式密集文档 · 第三行：图书教材</sub></p>

## 快速开始

### Docker 部署

```bash
git clone https://github.com/wxyhgk/retain-pdf.git
cd retain-pdf/ops/deployment/docker/delivery
docker compose up -d
```

启动后访问 <http://127.0.0.1:40001> 查看任务状态。更新服务：

```bash
docker compose pull
docker compose up -d
```

更多配置见 [Docker 部署说明](ops/deployment/docker/delivery/README.md)。

### Zotero 插件安装

Zotero 7+ 中打开 `工具 → 插件 → 齿轮菜单 → Install Plugin From File`，选择
[最新版 xpi](https://github.com/Hao-IANWY/zotero-retainpdf-plugin/releases/latest/download/retain-pdf.xpi)。
装好后先到设置里填服务地址与凭据（或改用[插件目录](plugin/)自行构建）。

## 开发

参阅 [贡献指南](CONTRIBUTING.md)、[项目文档](docs/README.md)和[后端说明](backend/README.md)。

## 致谢

本项目衍生自 [wxyhgk/retain-pdf](https://github.com/wxyhgk/retain-pdf)，并在其基础上独立演进。感谢上游作者的开源贡献。

## License

- 本仓库自有代码：MIT（见 [LICENSE](LICENSE)）
- `plugin/`（Zotero 插件）：AGPL-3.0-or-later，基于
  [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
- 运行时依赖 PyMuPDF 为 AGPL-3.0：自行部署即视为使用 AGPL 软件，请遵守其
  许可条款；本项目不发布官方 Docker 镜像，请从源码自行构建
