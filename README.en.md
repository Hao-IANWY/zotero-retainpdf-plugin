# RetainPDF: Layout-Preserving PDF Translation

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="resources/brand/RetainPDF-github.svg" alt="RetainPDF" width="320" />
</p>

RetainPDF is currently the only open-source project built for layout-preserving translation of image-based and scanned PDFs, with translation and typesetting quality that matches or even surpasses comparable commercial products.

**Core features**

- **Layout restoration**: in-house typography algorithm that restores complex formulas and multi-column paper layouts
- **Unmatched inline-formula preservation**: formulas, surrounding text, and inline layout stay intact after translation—something no other open-source PDF translator currently achieves
- **In-house translation system**: purpose-built for classic PDF challenges such as cross-column and cross-page passages, broken sentences, and continued paragraphs; complete semantic units are restored before translation, avoiding the context fragmentation of box-by-box translation
- **Full-featured**: scanned PDF translation, PDF structure optimization, code protection, custom translation strategies, and an open API—all included
- **Fully open**: code, API, and deployment are all open, ready for self-hosting and further development

## Core capability comparison

| Project | Scanned PDFs | Complex inline formulas | Protect code from translation | Table control | Custom translation strategy | Layout preservation | PDF size optimization | API automation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDFMathTranslate | ❌ | ❌ | ❌ | Limited | Limited | Average | Average | ✅ |
| PolyglotPDF | ❌ | ❌ | ❌ | Limited | Limited | Average | Average | ✅ |
| Doc2X | ✅ | ✅ | ❌ | Moderate | Limited | Strong | Limited | ❌ Not public |
| RetainPDF | ✅ | ✅ Strong preservation | ✅ | ✅ Optional | ✅ Rule-based | Strong | ✅ Continuously improved | ✅ |

## Product UI

Jobs are submitted from the [Zotero plugin](plugin/); the web UI centralizes execution status and artifacts.

### Task list

All jobs grouped by running / queued / failed / completed, with inline progress, cancel, and retry.

<p align="center">
  <img src="resources/brand/readme-gallery/product/task-list.png" alt="RetainPDF task list" width="1000" />
</p>

### Task detail

Per-job stage progress, failure diagnostics, event timeline, and artifact downloads.

<p align="center">
  <img src="resources/brand/readme-gallery/product/task-detail.png" alt="RetainPDF task detail" width="1000" />
</p>

## Translation examples

Source-to-translation examples for scientific papers, scanned PDFs, formula-heavy documents, and books:

<p align="center">
  <img src="resources/brand/readme-gallery/translation-examples.webp" alt="RetainPDF translation examples for papers, scanned PDFs, and books" width="1000" />
</p>

<p align="center"><sub>Row 1: scientific papers · Row 2: scanned and formula-heavy documents · Row 3: books and textbooks</sub></p>

## Quick start

### Option 1: Pre-built images (default)

```bash
git clone https://github.com/Hao-IANWY/zotero-retainpdf-plugin.git
cd zotero-retainpdf-plugin/ops/deployment/docker/delivery
docker compose up -d
```

Open <http://127.0.0.1:40001> to check task status. Images are pulled from GHCR by default.

See the [Docker deployment guide](ops/deployment/docker/delivery/README.md) for ports, secrets, reverse proxy, and more.

### Option 2: Build images locally

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
> - If the data directory owner differs from the container's default user (uid 1000), add `--build-arg RETAINPDF_UID=<your uid> --build-arg RETAINPDF_GID=<your gid>` to the build.

### Updating

With local images, rebuilding is updating:

```bash
git pull
# Re-run the builds and docker compose up -d above
```

### Zotero plugin installation

In Zotero 7+, open `Tools → Plugins → gear menu → Install Plugin From File` and select the
[latest xpi](https://github.com/Hao-IANWY/zotero-retainpdf-plugin/releases/latest/download/retain-pdf.xpi).
After installation, set the server address and credentials in the plugin settings (or build it yourself from the [plugin directory](plugin/)).

## Development

See the [contribution guide](CONTRIBUTING.md), [project documentation](docs/README.md), and [backend guide](backend/README.md).

## Acknowledgements

This project is derived from [wxyhgk/retain-pdf](https://github.com/wxyhgk/retain-pdf) and has evolved independently since. Thanks to the upstream author for open-sourcing the original work.

## License

- Original code in this repository: MIT (see [LICENSE](LICENSE))
- `plugin/` (Zotero plugin): AGPL-3.0-or-later, based on
  [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
- The runtime dependency PyMuPDF is AGPL-3.0: self-hosting counts as using AGPL
  software, so please comply with its terms. Pre-built images are published on GHCR
  (`ghcr.io/hao-ianwy/retainpdf-app` / `retainpdf-web`) and correspond one-to-one
  with the source in this repository; as required by AGPL, image users can obtain
  the complete corresponding source code here.
