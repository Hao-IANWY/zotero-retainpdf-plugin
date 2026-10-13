# RetainPDF: Layout-Preserving PDF Translation

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a> · <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <img src="resources/brand/RetainPDF-github.svg" alt="RetainPDF" width="320" />
</p>

RetainPDF is currently the only open-source project built for layout-preserving translation of image-based and scanned PDFs, with translation and typesetting quality that matches or even surpasses comparable commercial products.

Its in-house typography algorithm restores complex formulas and multi-column paper layouts. Scanned PDF translation, PDF structure optimization, code protection, custom translation strategies, and an open API are all included.

The translation system is also built in-house, with dedicated handling for cross-column and cross-page passages, broken sentences, and continued paragraphs. It restores complete semantic units before translation instead of translating isolated OCR boxes and losing context.

**Inline formulas are RetainPDF's defining advantage: formulas, surrounding text, and inline layout remain stable after translation—something other open-source PDF translators do not currently achieve.**

The code, API, and deployment stack are fully open, with support for self-hosting and further development.

Core capability comparison:

| Project | Scanned PDFs | Complex inline formulas | Protect code from translation | Table control | Custom translation strategy | Layout preservation | PDF size optimization | API automation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDFMathTranslate | ❌ | ❌ | ❌ | Limited | Limited | Average | Average | ✅ |
| PolyglotPDF | ❌ | ❌ | ❌ | Limited | Limited | Average | Average | ✅ |
| Doc2X | ✅ | ✅ | ❌ | Moderate | Limited | Strong | Limited | ❌ Not public |
| RetainPDF | ✅ | ✅ Strong preservation | ✅ | ✅ Optional | ✅ Rule-based | Strong | ✅ Continuously improved | ✅ |

## Product

The web UI focuses on task progress: jobs are submitted through the open API (scripts, integrations, or the [Zotero plugin](plugin/)), and the web pages centralize execution status and artifacts.

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

### Docker

```bash
git clone https://github.com/wxyhgk/retain-pdf.git
cd retain-pdf/ops/deployment/docker/delivery
docker compose up -d
```

Open <http://127.0.0.1:40001> to check task status. To update:

```bash
docker compose pull
docker compose up -d
```

See the [Docker deployment guide](ops/deployment/docker/delivery/README.md) for more options.

## Community

QQ group: `1101779791`

<p align="center">
  <img src="resources/brand/QQ_Group.JPG" alt="RetainPDF QQ group QR code" width="280" />
</p>

## Development

See the [contribution guide](CONTRIBUTING.md), [project documentation](docs/README.md), and [backend guide](backend/README.md).

## License

This project is distributed under the MIT License. See [LICENSE](LICENSE) for the full text.
