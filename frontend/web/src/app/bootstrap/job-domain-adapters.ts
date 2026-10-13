import { configureDefaultArtifactUrlConfigPort } from "@retainpdf/domain/job";
import { apiBase } from "@/platform/config/runtime.js";

// The domain package owns artifact naming and URL rules; the web host owns the
// runtime API configuration, so wire that capability before any page reads the
// package defaults.（上传态端口随网页上传流一并退役：现在任务只经 API/插件提交，
// 域包的默认空快照即可。）
configureDefaultArtifactUrlConfigPort({
  resolveApiBase: apiBase,
});
