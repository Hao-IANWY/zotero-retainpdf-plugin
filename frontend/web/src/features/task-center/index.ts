// task-center —— 任务中心：按状态分组展示全部任务（只读视图，无任务操作）。
//
// 这是本功能对外的唯一出口。
// ui/     TaskCenter 视图
// domain/ 分组/计数/文案模型、任务列表的 HTTP 调用

export { TaskCenter } from "./ui/TaskCenter.jsx";
export type {
  TaskCenterOpenBookDetailInput,
  TaskCenterProps,
} from "./ui/TaskCenter.jsx";
export {
  groupTaskCenterJobs,
  taskCenterCounts,
  taskDocumentLabel,
  taskGroupKey,
  taskIdentity,
  taskProgressPercent,
  taskStatusLabel,
  taskWorkflowLabel,
} from "./domain/model.js";
