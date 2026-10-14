# RetainPDF Zotero Plugin

[![zotero target version](https://img.shields.io/badge/Zotero-7%2B-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero 7+ 客户端插件（含 Zotero 10），为 RetainPDF 服务端提供"右键附件 → 整篇排版保留翻译 → 双语 PDF 挂回条目"的入口。

> 状态：全链路可用（右键翻译 → 上传 → 服务端 OCR/翻译 → 双语 PDF 挂回），版本随 release 发布。

## 安装（开发模式）

```bash
npm install
npm run build     # 产出 .scaffold/build/*.xpi
```

Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File，选择构建出的 `.xpi`。

热重载开发：`npm start`（需要本机 Zotero；配置见 zotero-plugin-scaffold 文档）。

## 配置

Zotero 设置 → RetainPDF，三张卡片（服务器 / OCR 识别 / 翻译模型）各带独立"检查连接"：

| 项       | 说明                                                                          | 默认                     |
| -------- | ----------------------------------------------------------------------------- | ------------------------ |
| 服务地址 | RetainPDF 服务端 Base URL                                                     | `http://127.0.0.1:40001` |
| OCR 识别 | PaddleOCR / MinerU 二选一，填对应 Token（随任务发送，服务端校验）             | MinerU，Token 空         |
| 翻译模型 | DeepSeek 预置 / 自定义 OpenAI 兼容端点；填 API Key 后点"获取模型列表"选择模型 | DeepSeek，Key 空         |
| 并发数   | 同时处理的翻译任务数                                                          | `5`                      |

插件不设服务端 API Key：访问控制由部署层（内网直连）兜底，请求不带 `X-API-Key`。

## 用法

右键任意含 PDF 附件的条目 → "使用 RetainPDF 翻译"：上传原 PDF → 服务端 OCR/翻译 → 双语 PDF 下载挂回条目，进度在进度窗实时显示。

## 许可证

AGPL-3.0-or-later。本项目基于 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)（AGPL-3.0）构建，按其许可随源码发布。RetainPDF 服务端是经 HTTP 通信的独立程序，不受本插件许可证影响。
