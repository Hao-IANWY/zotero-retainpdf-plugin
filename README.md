# RetainPDF

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="resources/brand/RetainPDF-github.svg" alt="RetainPDF" width="320" />
</p>

<p align="center">
  <a href="https://www.zotero.org"><img src="https://img.shields.io/badge/Zotero-7%2B-green?style=flat-square&logo=zotero&logoColor=CC2936" alt="Zotero 7+"></a>
  <a href="https://github.com/Hao-IANWY/zotero-retainpdf-plugin/releases/latest"><img src="https://img.shields.io/github/v/release/Hao-IANWY/zotero-retainpdf-plugin?style=flat-square" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT%20%2B%20AGPL--3.0-blue?style=flat-square" alt="License: MIT + AGPL-3.0"></a>
</p>

**在 Zotero 里右键翻译论文，公式与排版原样保留。**

纯译文和双语对照两个 PDF 自动挂回条目，打开即读。支持扫描件、多栏论文与复杂行内公式。

<!--
  TODO(素材): 首屏 Hero GIF
  录制内容：条目右键「使用 RetainPDF 翻译」→ 进度窗 → 条目下出现 mono.pdf / dual.pdf
  建议路径：resources/brand/readme-gallery/plugin/hero.gif
  录制完成后把本注释替换为：
  <p align="center"><img src="resources/brand/readme-gallery/plugin/hero.gif" alt="在 Zotero 中右键翻译并自动挂回" width="800" /></p>
-->

## 为什么是 RetainPDF

- **公式不再被打碎**：逐框翻译会把行内公式和上下文切散；RetainPDF 先恢复完整语义单元，再按排版结构翻译
- **扫描件也能翻**：没有文本层的图片型 PDF，走内置 OCR 链路识别后再翻译
- **不用手动搬运**：翻译完成后纯译文与双语对照自动挂回 Zotero 条目，无需下载、改名、拖回

## 核心能力

- **右键即译，产物自动归档**：在 Zotero 中右键任意含 PDF 的条目（可多选）→「使用 RetainPDF 翻译」，完成后 `mono.pdf`（纯译文）与 `dual.pdf`（双语对照）直接挂在原条目下
- **扫描件可翻**：PaddleOCR / MinerU 二选一，Token 随任务发送到你自己的服务端
- **排版级还原**：自研排版算法，稳定保留行内公式、多栏结构、表格与代码块；代码保护、表格控制、PDF 压缩优化可配置
- **中控台**：Zotero 搜索栏旁的 RetainPDF 按钮打开，运行 / 排队 / 失败 / 完成分组查看，SSE 实时进度
- **模型自带**：DeepSeek 预置，也支持任意 OpenAI 兼容端点；填 Key 后一键获取模型列表
- **失败可诊断**：失败原因以可读的 root cause 呈现，并附带处理建议，不用翻日志猜

## 效果展示

SCI 论文、图片型 / 扫描版 PDF 与图书教材的原文—译文对照：

<p align="center">
  <img src="resources/brand/readme-gallery/translation-examples.webp" alt="RetainPDF SCI 论文、扫描 PDF 与图书教材翻译效果合集" width="1000" />
</p>

<p align="center"><sub>第一行：SCI 论文 · 第二行：扫描与公式密集文档 · 第三行：图书教材</sub></p>

## 和同类项目的区别

| 项目 | Zotero 集成 | 扫描件 | 复杂行内公式 | 排版保留 | 双语对照 | 开放 API |
| --- | --- | --- | --- | --- | --- | --- |
| [zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh) | 右键菜单 | 依赖 pdf2zh_next 的 OCR 配置 | 依赖上游引擎 | 一般 | ✅ | 本地服务端 |
| [PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate) | — | ❌ | ❌ | 一般 | ✅ | ✅ |
| PolyglotPDF | — | ❌ | ❌ | 一般 | — | ✅ |
| [Doc2X](https://doc2x.noedgeai.com/) | — | ✅ | ✅ | 强 | — | ❌ 不开放 |
| **RetainPDF** | **右键菜单 + 中控台** | **✅** | **✅ 强保留** | **强** | **✅** | **✅** |

<sub>对比基于各项目公开资料（截至 2026-10），以各自最新版本为准。</sub>

## 快速开始

### 1. 启动服务端

```bash
git clone https://github.com/Hao-IANWY/zotero-retainpdf-plugin.git
cd zotero-retainpdf-plugin/ops/deployment/docker/delivery
docker compose up -d
```

默认拉取本仓库发布在 GHCR 的预构建镜像。启动后访问 <http://127.0.0.1:40001> 可查看任务状态。

### 2. 安装 Zotero 插件

Zotero 7+（含 Zotero 10）打开 `工具 → 插件 → 齿轮菜单 → Install Plugin From File`，选择
[最新版 xpi](https://github.com/Hao-IANWY/zotero-retainpdf-plugin/releases/latest/download/retain-pdf.xpi)。

### 3. 填写设置

打开 `Zotero 设置 → RetainPDF`，三张卡片各带独立的「检查连接」：

| 卡片 | 填写内容 |
| --- | --- |
| 服务器 | 服务地址，默认 `http://127.0.0.1:40001` |
| OCR 识别 | PaddleOCR / MinerU 二选一，填对应 Token |
| 翻译模型 | DeepSeek 预置，或自定义 OpenAI 兼容端点；填 Key 后点「获取模型列表」选择模型 |

并发数在同一页面配置，默认 5。

<!--
  TODO(素材): 设置页截图
  建议路径：resources/brand/readme-gallery/plugin/preferences.png
  录制完成后把本注释替换为：
  <p align="center"><img src="resources/brand/readme-gallery/plugin/preferences.png" alt="RetainPDF 插件设置（服务器 / OCR / 翻译模型）" width="900" /></p>
-->

### 4. 右键翻译

在 Zotero 中选中条目（可多选）→ 右键 →「使用 RetainPDF 翻译」。进度窗实时显示阶段与百分比；完成后原条目下出现：

- `mono.pdf`：纯译文
- `dual.pdf`：原文 / 译文双语对照

<!--
  TODO(素材): 条目下两个产物附件的截图
  建议路径：resources/brand/readme-gallery/plugin/attachments.png
  录制完成后把本注释替换为：
  <p align="center"><img src="resources/brand/readme-gallery/plugin/attachments.png" alt="译文与双语对照自动挂回 Zotero 条目" width="700" /></p>
-->

<details>
<summary><b>高级：本地构建镜像、反代与更新</b></summary>

#### 本地构建镜像

想跟随最新源码或自定制，可本地构建替换：

```bash
cd <仓库根目录>
docker build --build-arg TYPST_VERSION=0.15.1 \
  -f ops/deployment/docker/backend/Dockerfile.app -t retainpdf-app:local .
docker build --build-arg RETAIN_PDF_VERSION=local \
  -f ops/deployment/docker/Dockerfile.web -t retainpdf-web:local .
cd ops/deployment/docker/delivery
APP_IMAGE=retainpdf-app:local WEB_IMAGE=retainpdf-web:local docker compose up -d
```

> [!TIP]
> - 首次构建约 10–20 分钟（270 个 Rust crate），之后有分层缓存、秒级增量。
> - 若数据目录属主与容器默认用户（uid 1000）不一致，构建时加 `--build-arg RETAINPDF_UID=<你的uid> --build-arg RETAINPDF_GID=<你的gid>`。

#### 更新服务

```bash
git pull
# 重新执行上面的 build 与 docker compose up -d
```

#### 端口、密钥与反向代理

见 [Docker 部署说明](ops/deployment/docker/delivery/README.md)。

</details>

## 产品界面

### Zotero 中控台

<!--
  TODO(素材): 中控台截图
  建议路径：resources/brand/readme-gallery/plugin/dashboard.png
  录制完成后把本注释替换为：
  <p align="center"><img src="resources/brand/readme-gallery/plugin/dashboard.png" alt="RetainPDF 中控台任务列表" width="1000" /></p>
-->

点击 Zotero 搜索栏旁的 RetainPDF 按钮打开，按运行 / 排队 / 失败 / 完成分组查看任务，支持实时进度、清空记录与跳转详情。

### 服务端任务中心

服务端网页端集中查看全部任务的执行状态与产物。

**任务列表**：按 运行 / 排队 / 失败 / 完成 分组集中查看全部任务，行内进度与取消/重试。

<p align="center">
  <img src="resources/brand/readme-gallery/product/task-list.png" alt="RetainPDF 任务列表" width="1000" />
</p>

**任务详情**：单任务的阶段进度、失败诊断、事件时间线与产物下载。

<p align="center">
  <img src="resources/brand/readme-gallery/product/task-detail.png" alt="RetainPDF 任务详情" width="1000" />
</p>

## 常见问题

**插件连不上服务端？**
确认容器已启动、服务地址填写正确（默认 `http://127.0.0.1:40001`），再点设置里的「检查连接」。如果服务端在另一台机器，填写其内网地址并确认防火墙放行。

**翻译失败怎么排查？**
进度窗会显示失败原因；Zotero 中控台或网页端任务详情里能看到完整的 root cause 与处理建议。

**扫描件需要额外配置吗？**
需要。在设置里选择 PaddleOCR 或 MinerU 并填写对应 Token，任务会自动走 OCR 链路。

**用哪个翻译模型？**
内置 DeepSeek 配置；也可以填任意 OpenAI 兼容端点的地址与 Key，点「获取模型列表」选择模型。

**译文文件在哪？为什么有两个？**
都挂在原条目下：`mono.pdf` 是纯译文，`dual.pdf` 是原文 / 译文双语对照。

**必须自己部署服务端吗？**
是。插件连接任意可达的 RetainPDF 实例（本机、内网或反向代理后的地址）。

**数据和密钥会发到哪里？**
PDF、OCR Token 与模型 Key 只发送到你自己配置的服务端；项目不提供任何第三方托管服务。

## 更新与开发

版本与变更见 [Releases](https://github.com/Hao-IANWY/zotero-retainpdf-plugin/releases)。

参与开发请参阅 [贡献指南](CONTRIBUTING.md)、[项目文档](docs/README.md)、[后端说明](backend/README.md)与[插件说明](plugin/README.md)。

## 致谢

本项目衍生自 [wxyhgk/retain-pdf](https://github.com/wxyhgk/retain-pdf)，并在其基础上独立演进；Zotero 插件基于 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)。感谢上游作者与模板维护者的开源贡献。

本项目已链接并认可 [**LINUX DO**](https://linux.do/) 社区，感谢社区提供的技术交流氛围与支持。

## License

- 本仓库自有代码：MIT（见 [LICENSE](LICENSE)）
- `plugin/`（Zotero 插件）：AGPL-3.0-or-later，基于
  [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
- 运行时依赖 PyMuPDF 为 AGPL-3.0：自行部署即视为使用 AGPL 软件，请遵守其
  许可条款。预构建镜像发布在 GHCR（`ghcr.io/hao-ianwy/retainpdf-app` /
  `retainpdf-web`），与本仓库源码一一对应；AGPL 要求下，镜像使用者同样可以
  在本仓库获取完整对应源码
