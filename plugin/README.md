# RetainPDF Zotero Plugin

[![zotero target version](https://img.shields.io/badge/Zotero-7%2B-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero 7+ 客户端插件（含 Zotero 10），为 RetainPDF 服务端提供"右键附件 → 整篇排版保留翻译 → 双语 PDF 挂回条目"的入口。

> 状态：M0 脚手架（右键菜单 + 附件识别 + 偏好配置 + 连接检查）。
> 上传与翻译链路按里程碑推进，见 [docs/ops/planning/milestones.md](docs/ops/planning/milestones.md)。

## 安装（开发模式）

```bash
npm install
npm run build     # 产出 .scaffold/build/*.xpi
```

Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File，选择构建出的 `.xpi`。

热重载开发：`npm start`（需要本机 Zotero；配置见 zotero-plugin-scaffold 文档）。

## 配置

Zotero 设置 → RetainPDF：

| 项 | 说明 | 默认 |
|---|---|---|
| 服务地址 | RetainPDF 服务端 Base URL | `http://127.0.0.1:40001` |
| API Key | 服务端 `RUST_API_KEYS` 中的钥匙 | 空 |
| 目标语言 | 翻译目标语言 | `zh` |

填好后点"检查连接"应显示服务端版本。

## 用法（M0）

右键任意含 PDF 附件的条目 → "使用 RetainPDF 翻译"。M0 阶段会识别并列出 PDF 附件路径；上传与翻译将在 M1 接通。

## 许可证

AGPL-3.0-or-later。本项目基于 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)（AGPL-3.0）构建，按其许可随源码发布。RetainPDF 服务端是经 HTTP 通信的独立程序，不受本插件许可证影响。
