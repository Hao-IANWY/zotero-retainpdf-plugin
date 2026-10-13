export function renderJobDetailActionLinks({
  actions = {},
  setActionLink,
}: any = {}) {
  // 阅读器按钮（detail-reader-btn → reader.html）已随网页端收缩退役：
  // 网页端只剩任务列表 + 任务详情，阅读交给 Zotero 插件/本地阅读器。
  setActionLink("detail-pdf-btn", actions.pdf, actions.pdfEnabled && !!actions.pdf);
}
