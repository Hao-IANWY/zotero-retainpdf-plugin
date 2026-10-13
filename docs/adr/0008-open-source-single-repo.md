# 0008 服务端开源与单仓库发布

> 状态：已采纳（2026-10-12）。执行中：squash 公开仓库 `zotero-retainpdf-plugin`。

## 背景

插件（ADR 0007）公开后"他人拿到插件无后端可用"的分发问题需要解法。
三条路线（README 指路 upstream / 开源服务端 / 托管 SaaS）中，托管 SaaS 触发
AGPL 网络条款与部署改造，超出当前阶段；仅指路 upstream 则受 fork 契约漂移困扰。
产品以 Zotero 插件为门面（对标 zotero-pdf2zh），服务端是它的引擎。

## 决策

1. **整个项目开源**：新建公开仓库 `zotero-retainpdf-plugin`（单仓库，插件在
   `plugin/`，服务端与文档在根），私有仓库保留全部历史作档案，不再更新。
2. **squash 重建公开历史**：公开仓库以当前快照为唯一初始提交。原因：全历史
   审计发现 3 个历史 blob 含真实 DeepSeek key、commit 作者混有私人 QQ 邮箱——
   清洗历史（filter-repo）成本高且易漏，squash 让敏感内容根本不出门。
3. **许可证姿态**：自有代码维持 MIT（目录级）；`plugin/` 因 AGPL 底座随
   AGPL-3.0 发布（ADR 0007 修正注记）；PyMuPDF 为 AGPL 运行时依赖，README
   声明自行部署需遵守其许可。**不发布官方 Docker 镜像**——镜像打包构成
   组合作品分发，开源姿态下义务虽可履行，但"源码自建"更省事且零风险。
4. **历史泄漏的 DeepSeek key 建议轮换**（squash 下不会扩散，属纵深防御）。

## 后果

- 公开历史从 v4.2.x 起步，无 fork 历史包袱；文档中引用的私有 commit hash
  在公开仓库无对应物，属预期。
- 插件 xpi、update.json 与服务端发版共用同一 Releases 通道。
- 私有仓库降为本地档案（含 skip-worktree 的交付配置），不推送新提交。

## 替代方案

- **filter-repo 清洗后直接公开私有仓库**：保留完整历史，但需重写全部 blob
  与作者信息，文档引用的 hash 全部失效，且遗漏即泄漏，否决。
- **维持私有 + 插件指路 upstream**：零许可证成本，但受 fork 漂移困扰且
  无法承载插件公开更新通道，被单仓库方案覆盖。
- **托管 SaaS**：AGPL 网络条款 + Access 拓扑改造，现阶段不启动。
