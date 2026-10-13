// job-detail —— detail.html 任务详情整页实现。
//
// 这是本功能对外的唯一出口。
// ui/page/     页面展示组件（Header、运行信息/失败诊断卡、产物、事件时间线）
// domain/page/ 页面的产物、续跑、路由与摘要逻辑
//
// 历史上的“弹窗实现”（ui/StatusDetail*.tsx + domain/dialog/*，挂在主页
// 状态卡上）已随网页端收缩为「任务列表 + 任务详情」两页一并退役；
// 现在只剩整页实现这一种形态。
// 展示模型真值在 @retainpdf/domain；跨功能依赖走对方的出口，
// 本功能不引用页面装配层。

export { useLiveProgressEffect } from "./ui/use-live-progress.js";
export {
  renderJobDetailActionLinks,
} from "./domain/page/action-links.js";
export {
  createJobDetailConfigPort,
  defaultJobDetailConfigPort,
} from "./domain/page/config-port.js";
export {
  createJobDetailDataPort,
  defaultJobDetailDataPort,
} from "./domain/page/data-port.js";
export {
  loadAndRenderMarkdownFlow,
} from "./domain/page/markdown-flow.js";
export {
  renderJobDetailOverview,
} from "./domain/page/overview-renderer.js";
export {
  createJobDetailPageState,
  revokeJobDetailMarkdownImageUrls,
} from "./domain/page/page-state.js";
export {
  createJobDetailResumePort,
  defaultJobDetailResumePort,
} from "./domain/page/resume-port.js";
export {
  bindRerunButton,
} from "./domain/page/resume.js";
export {
  getJobIdFromQuery,
} from "./domain/page/routing.js";
export {
  renderJobDetailFailureSummary,
  renderJobDetailRuntimeSummary,
} from "./domain/page/summary.js";

// detail.html 整页的展示组件。
// 逐个显式列出，不用 export * —— barrel 无差别转出会连带触发模块级副作用。
export { DetailHeader } from "./ui/page/DetailHeader.js";
export {
  ErrorNoticeCard,
  JobSummaryCard,
  MetaRow,
} from "./ui/page/JobSummaryCard.js";
export { ErrorDiagnostics } from "./ui/page/ErrorDiagnostics.js";
export {
  ArtifactsSection,
  MarkdownCard,
} from "./ui/page/ArtifactsSection.js";
export {
  EventsModal,
  EventsTriggerCard,
  StageHistoryModal,
  StageHistoryTriggerCard,
} from "./ui/page/EventsTimeline.js";
