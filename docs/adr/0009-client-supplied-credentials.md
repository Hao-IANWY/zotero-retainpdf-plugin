# 0009 - 凭证前置到客户端，服务端鉴权改为可选

状态：已执行 · 2026-10-12

## 背景

Zotero 插件（ADR 0007）M0 真机验证通过后，产品方向确定：**服务端直接放开**，
每次翻译由客户端随任务携带运行凭据——PaddleOCR key、使用的 LLM（model/base_url/api_key）、
并发数。这些此前都在服务端 `.env.local` 里配置。

契约层早已支持按任务携带：`create-job.v1` 的 `ocr.paddle_token`、
`translation.model/base_url/api_key/workers`（ADR 0007 定下的原生契约），
且语义是"请求带了凭据就一律不动，没带则用 env 兜底"。

剩下的问题是服务端强制 `X-API-Key`：客户端必须先拿到访问密钥才能调通任何接口，
对"插件填个地址就能用"的目标是多余一跳；`dev_stack` 还强制注入默认 key 并禁止
非回环监听使用默认 key。

## 决策

1. **鉴权可选化**：`RUST_API_KEYS` / `auth.local.json` 均未提供有效密钥时，
   rust_api 与 jobsd 进入开放模式，接口匿名可用（两处同规则）；配置了密钥则照旧
   强制校验。开放模式启动时输出警告日志。
2. **凭证前置**：客户端（Zotero 插件偏好页）保存 `paddle_token`、`model`、
   `base_url`、`api_key`、`workers`，每次提交任务随单携带；服务端 env 退化为
   兜底默认。
3. **dev_stack**：删除 `dev-local-key` 默认注入与"非回环监听必须配非默认 key"
   的强制检查，`RUST_API_KEYS` 原样透传。

## 后果

- 服务端进程本身不再是安全边界；暴露面的防护责任转移到部署层
  （nginx 门 / Cloudflare Access / VPN，见施工图 §6）。远程部署想要应用层锁时
  配置 `RUST_API_KEYS` 即可，无需改代码。
- 契约 schema 不变（`contracts/` byte-parity 不动）；改动集中在配置加载、
  中间件与开发栈脚本。
- 插件的"访问密钥"字段降级为可选（服务端上锁时才填）。

## 替代方案

- **彻底删除鉴权代码**：被否——保留机制让远程部署（M4）可以零改动上锁，
  删除是单向门。
- **保留强制鉴权 + 插件引导生成 key**：多一次引导握手，对单用户本地部署过重。
- **只改插件不改服务端**：不满足"服务端直接放开"的前提，插件仍必须先拿 key。
