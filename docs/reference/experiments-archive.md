# experiments/ 退役档案

`experiments/` 目录已于 2026-10-13 整体退役删除（约 270 个文件 / 78MB）。
本文收录各实验的最终结论；完整过程记录（脚本、fixture、逐次数据）保留在
git 历史中，需要复跑时从删除前的 commit 恢复即可。

## 1. layout-fit —— 排版拟合实验室

目标：用 HTML/CSS 与 `pretext` 做块级文本排版拟合，反哺 Typst 的字号/行高/段落参数选择。

**pretext 评估结论（第一层）**：
`@chenglou/pretext` 值得进候选方案清单，但不应作为唯一测量内核。正确定位是
与 DOM 基线双轨并行，用同一批 fixtures 对照 `lineCount / height / maxLineWidth /
overflow / score`。注意 pretext 的 `prepare()/layout()` 需要浏览器侧
`OffscreenCanvas`/DOM canvas，不能跑纯 Node CLI。

**PoC 结果（2026-04-07，样本 p002-b0002）**：
DOM 与 pretext 的块级高度差 0.04pt、行数一致（8 行），断行高度口径可用；
但暴露了 `maxLineWidth` 口径不一致问题——DOM 侧读 `scrollWidth`（整盒滚动宽）
而 pretext 是逐行文本宽，扩展样本前必须先统一"最宽行"指标口径。

**跨页/跨栏问题的根因与修法（最重要的一课）**：
三层错误叠加——(1) 上游把跨页段落拆成独立 block，preview 层按单框排版导致
续接失败，修法是恢复 flow group 语义（group_id / prev_block_id / next_block_id），
多框串流逐框消费行；(2) 续接块 `translated_text` 为空回退成英文原文，修法是
回退到 Typst overlay 的 `markdown_text`；(3) pretext 浏览器像素与 PDF pt 单位
混用导致断行不稳，修法是先换算到像素坐标系排版、再换回 pt 评分。
经验：上游为工程方便拆碎段落时，preview/渲染层必须恢复"段落流"语义，
否则跨页、跨栏场景怎么调字号行高都是结构性错误。

## 2. render-benchmark-533 —— 533 页渲染基准

用真实 job `20260514183142-dec42e` 抽象的大文档可复现渲染 benchmark
（正文/标题/脚注/图注/行内与行间公式/复杂背景/overlay 合并）。

**参考基线（当时开发机，warm）**：
533 页端到端 render 20.66s；其中 overlay diagnostics 18.94s、payload prepare
3.08s、Typst source prepare 7.36s、Typst compile 6.18s、PDF merge 2.13s；
单独编译导出的 Typst case 6.28s。

case 数据（case-data/、runs/、typst-cases/）从未入库，复跑需原始 job 数据包。

## 3. doc2x-gs —— PDF 内容流删正文实验

验证"删正文留公式"的精细路线：不整页栅格化、不按大 bbox 一刀切，直接改写
PDF content stream——删除正文的 `TJ/Tj` text-show 操作，保留行间公式的细碎
`Tj/Tm` 操作与矢量元素。样本 POC 成功（第 1 页英文正文删除、3 个行间公式
完整保留、PDF 未图片化）。

**推荐集成方向**：优先 `apply_redactions + show_pdf_page`（工程复杂度远低于
完整 text-op interpreter）。后端流程：OCR 阶段保留 `display_formula` bbox →
cleanup 对正文翻译 bbox 做 redaction → 按公式 bbox 从原 PDF clip 回贴 →
叠加 Typst 中文译文 → 回贴失败时降级到现有 bbox cover/strip。

## 4. problem/translation.md —— 翻译架构提案

1072 行的 12 节设计提案：总体架构、block/paragraph/page/TU 划分、
continuation detection（LLM 前规则初筛 + LLM 只处理低置信度候选）、
quality gate P0–P3 分级、repair pipeline（小输入/分类/失败降级）、
tail latency（timeout/429/5xx/慢 item/tail retry 时机/batch 策略）、
glossary 按 item 注入、translation memory 并发合并节奏、防模型解释泄漏、
公式 placeholder 保护、500+ 页 metrics 体系。

核心条目已在生产 `translate/` 落地（tail retry、TM 并发快照、quality gate
分级等），提案作为这些设计的历史依据存档。

## 5. claude-design —— 前端设计参考稿

9 个 jsx/html 进度动画设计稿（OCR→翻译→渲染各阶段）。Web 端两页形态
（任务列表 + 详情）定型后无代码消费，随目录退役。

## 6. tmp/

一次性临时输出，无结论价值。
