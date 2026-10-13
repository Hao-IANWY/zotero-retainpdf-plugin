# 前端与客户端

- `web/`：网页入口（任务列表 + 任务详情两页 MPA）。
- `packages/`：前端共享 UI、HTTP 客户端与展示模型。

跨端协议来自根 `contracts/`，不从后端源码导入实现。
工作区及锁文件由仓库根统一管理。构建执行 `npm run build:web`，
测试入口见 [项目测试说明](../tests/README.md)。
