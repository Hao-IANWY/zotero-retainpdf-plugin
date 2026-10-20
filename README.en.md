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

**Right-click a paper in Zotero and translate it — formulas and layout stay intact.**

Both a monolingual translation and a side-by-side bilingual PDF are attached back to the item, ready to read. Works with scanned papers, multi-column layouts, and complex inline formulas.

<!--
  TODO(asset): hero GIF
  Record: right-click an item → "Translate with RetainPDF" → progress window → mono.pdf / dual.pdf appear under the item
  Suggested path: resources/brand/readme-gallery/plugin/hero.gif
  Replace this comment with:
  <p align="center"><img src="resources/brand/readme-gallery/plugin/hero.gif" alt="Translate from Zotero and get the results attached automatically" width="800" /></p>
-->

## Why RetainPDF

- **Formulas stay intact**: box-by-box translation breaks inline formulas and context; RetainPDF restores complete semantic units first, then translates along the layout structure
- **Scanned papers work too**: image-only PDFs without a text layer go through the built-in OCR pipeline before translation
- **No manual file shuffling**: the translation and the bilingual copy are attached back to the Zotero item automatically — no download, rename, or drag-and-drop

## Core features

- **Right-click to translate, artifacts filed automatically**: right-click any item with a PDF attachment (multi-select supported) → "Translate with RetainPDF". When done, `mono.pdf` (translation) and `dual.pdf` (side-by-side) are attached under the original item
- **Scanned PDFs supported**: choose PaddleOCR or MinerU; the token is sent with the job to your own server
- **Layout-level restoration**: the in-house typesetting engine preserves inline formulas, multi-column structure, tables, and code blocks; code protection, table control, and PDF size optimization are configurable
- **Dashboard**: open it from the RetainPDF button next to the Zotero search bar; jobs grouped by running / queued / failed / completed, with live SSE progress
- **Bring your own model**: DeepSeek is preconfigured, and any OpenAI-compatible endpoint works; enter a key and fetch the model list in one click
- **Readable failures**: a human-readable root cause plus a suggested fix, instead of digging through logs

## Translation examples

Source-to-translation examples for scientific papers, scanned PDFs, and books:

<p align="center">
  <img src="resources/brand/readme-gallery/translation-examples.webp" alt="RetainPDF translation examples for papers, scanned PDFs, and books" width="1000" />
</p>

<p align="center"><sub>Row 1: scientific papers · Row 2: scanned and formula-heavy documents · Row 3: books and textbooks</sub></p>

## How it compares

| Project | Zotero integration | Scanned PDFs | Complex inline formulas | Layout preservation | Bilingual output | Open API |
| --- | --- | --- | --- | --- | --- | --- |
| [zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh) | Right-click menu | Depends on pdf2zh_next OCR configuration | Depends on upstream engine | Average | ✅ | Local server |
| [PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate) | — | ❌ | ❌ | Average | ✅ | ✅ |
| PolyglotPDF | — | ❌ | ❌ | Average | — | ✅ |
| [Doc2X](https://doc2x.noedgeai.com/) | — | ✅ | ✅ | Strong | — | ❌ Not public |
| **RetainPDF** | **Right-click menu + dashboard** | **✅** | **✅ Strong preservation** | **Strong** | **✅** | **✅** |

<sub>Based on public project information as of 2026-10; refer to each project's latest release.</sub>

## Quick start

### 1. Start the server

```bash
git clone https://github.com/Hao-IANWY/zotero-retainpdf-plugin.git
cd zotero-retainpdf-plugin/ops/deployment/docker/delivery
docker compose up -d
```

Pre-built images are pulled from GHCR by default. Open <http://127.0.0.1:40001> to check task status.

### 2. Install the Zotero plugin

In Zotero 7+ (including Zotero 10), open `Tools → Plugins → gear menu → Install Plugin From File` and select the
[latest xpi](https://github.com/Hao-IANWY/zotero-retainpdf-plugin/releases/latest/download/retain-pdf.xpi).

### 3. Configure the plugin

Open `Zotero Settings → RetainPDF`. Each of the three cards has its own "Check connection" button:

| Card | What to fill in |
| --- | --- |
| Server | Server address, default `http://127.0.0.1:40001` |
| OCR | PaddleOCR or MinerU, with the corresponding token |
| Translation model | DeepSeek preconfigured, or a custom OpenAI-compatible endpoint; enter a key and click "Fetch models" |

Concurrency is configured on the same page (default 5).

<!--
  TODO(asset): preferences screenshot
  Suggested path: resources/brand/readme-gallery/plugin/preferences.png
  Replace this comment with:
  <p align="center"><img src="resources/brand/readme-gallery/plugin/preferences.png" alt="RetainPDF plugin settings (server / OCR / translation model)" width="900" /></p>
-->

### 4. Translate from the context menu

Select one or more items in Zotero → right-click → "Translate with RetainPDF". The progress window shows the current stage and percentage in real time. When finished, two files appear under the original item:

- `mono.pdf`: the translated PDF
- `dual.pdf`: side-by-side source and translation

<!--
  TODO(asset): screenshot of the two attachments under an item
  Suggested path: resources/brand/readme-gallery/plugin/attachments.png
  Replace this comment with:
  <p align="center"><img src="resources/brand/readme-gallery/plugin/attachments.png" alt="Translation and bilingual copy attached back to the Zotero item" width="700" /></p>
-->

<details>
<summary><b>Advanced: build locally, reverse proxy, updating</b></summary>

#### Build images locally

To track the latest source or customize the build, build and swap in local images:

```bash
cd <repo root>
docker build --build-arg TYPST_VERSION=0.15.1 \
  -f ops/deployment/docker/backend/Dockerfile.app -t retainpdf-app:local .
docker build --build-arg RETAIN_PDF_VERSION=local \
  -f ops/deployment/docker/Dockerfile.web -t retainpdf-web:local .
cd ops/deployment/docker/delivery
APP_IMAGE=retainpdf-app:local WEB_IMAGE=retainpdf-web:local docker compose up -d
```

> [!TIP]
> - The first build takes about 10–20 minutes (270 Rust crates); layered caching makes later rebuilds near-instant.
> - If the data directory owner differs from the container's default user (uid 1000), add `--build-arg RETAINPDF_UID=<your uid> --build-arg RETAINPDF_GID=<your gid>`.

#### Updating

```bash
git pull
# Re-run the builds and docker compose up -d above
```

#### Ports, secrets, and reverse proxy

See the [Docker deployment guide](ops/deployment/docker/delivery/README.md).

</details>

## Product UI

### Zotero dashboard

<!--
  TODO(asset): dashboard screenshot
  Suggested path: resources/brand/readme-gallery/plugin/dashboard.png
  Replace this comment with:
  <p align="center"><img src="resources/brand/readme-gallery/plugin/dashboard.png" alt="RetainPDF dashboard task list" width="1000" /></p>
-->

Open it from the RetainPDF button next to the Zotero search bar. Jobs are grouped by running / queued / failed / completed, with live progress, clearing, and details.

### Server task center

The web UI centralizes execution status and artifacts for all jobs.

**Task list**: all jobs grouped by running / queued / failed / completed, with inline progress and cancel/retry.

<p align="center">
  <img src="resources/brand/readme-gallery/product/task-list.png" alt="RetainPDF task list" width="1000" />
</p>

**Task detail**: per-job stage progress, failure diagnostics, event timeline, and artifact downloads.

<p align="center">
  <img src="resources/brand/readme-gallery/product/task-detail.png" alt="RetainPDF task detail" width="1000" />
</p>

## FAQ

**The plugin cannot reach the server.**
Make sure the containers are running and the server address is correct (default `http://127.0.0.1:40001`), then click "Check connection" in the settings. If the server runs on another machine, use its LAN address and make sure the firewall allows it.

**How do I diagnose a failed translation?**
The progress window shows the reason; the Zotero dashboard or the web task detail page shows the full root cause and suggested fix.

**Do scanned PDFs need extra configuration?**
Yes. Select PaddleOCR or MinerU in the settings and enter the corresponding token; the job will go through the OCR pipeline automatically.

**Which translation model should I use?**
DeepSeek is preconfigured. You can also enter the address and key of any OpenAI-compatible endpoint and click "Fetch models".

**Where are the translated files? Why are there two?**
Both are attached under the original item: `mono.pdf` is the translation, `dual.pdf` is the side-by-side bilingual copy.

**Do I have to host the server myself?**
Yes. The plugin connects to any reachable RetainPDF instance (local, LAN, or behind a reverse proxy).

**Where do my data and keys go?**
PDFs, OCR tokens, and model keys are sent only to the server you configured. The project does not provide any third-party hosting service.

## Releases and development

See [Releases](https://github.com/Hao-IANWY/zotero-retainpdf-plugin/releases) for versions and changes.

See the [contribution guide](CONTRIBUTING.md), [project documentation](docs/README.md), [backend guide](backend/README.md), and [plugin guide](plugin/README.md).

## Acknowledgements

This project is derived from [wxyhgk/retain-pdf](https://github.com/wxyhgk/retain-pdf) and has evolved independently since. The Zotero plugin is based on [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template). Thanks to the upstream author and the template maintainers for open-sourcing their work.

This project links to and recognizes the [**LINUX DO**](https://linux.do/) community. Thanks to the community for technical exchange and support.

## License

- Original code in this repository: MIT (see [LICENSE](LICENSE))
- `plugin/` (Zotero plugin): AGPL-3.0-or-later, based on
  [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
- The runtime dependency PyMuPDF is AGPL-3.0: self-hosting counts as using AGPL
  software, so please comply with its terms. Pre-built images are published on GHCR
  (`ghcr.io/hao-ianwy/retainpdf-app` / `retainpdf-web`) and correspond one-to-one
  with the source in this repository; as required by AGPL, image users can obtain
  the complete corresponding source code here.
