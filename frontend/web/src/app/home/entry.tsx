// 任务列表页 React 入口（产物 dist/app.bundle.js，由 index.html 挂载）。
// 启动顺序见 src/app/shell-boot.ts：adapters → bootTheme → 找根 → 挂载（不开 StrictMode）。
// 页面主体见 TaskListApp.tsx；无 composition、无事件桥。

import { TaskListApp } from "./TaskListApp.jsx";
import { mountShellPage } from "../shell-boot.js";

mountShellPage("home-root", <TaskListApp />, { createIfMissing: true });
