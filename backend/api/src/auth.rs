use axum::body::Body;
use axum::http::{HeaderMap, Method, Request};
use axum::middleware::Next;
use axum::response::Response;

use crate::error::AppError;
use crate::routes::common::{build_auth_route_deps, AuthRouteDeps};
use crate::AppState;

fn has_valid_api_key(deps: AuthRouteDeps<'_>, request: &Request<Body>) -> bool {
    request
        .headers()
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|key| crate::config::api_key_matches(deps.api_keys, key))
        .unwrap_or(false)
}

pub async fn require_api_key(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    if request.method() == Method::OPTIONS {
        return Ok(next.run(request).await);
    }

    let deps = build_auth_route_deps(&state);
    // 与 jobsd 的 authorized 同规则：未配置访问密钥 = 开放模式，接口匿名可用
    //（客户端按任务自带模型/OCR 凭证，服务端不再强制访问密钥）。
    if deps.api_keys.is_empty() {
        return Ok(next.run(request).await);
    }

    if has_valid_api_key(deps, &request) {
        return Ok(next.run(request).await);
    }

    Err(AppError::unauthorized("missing or invalid X-API-Key"))
}

/// 浏览器来源门禁。匿名模式 ≠ 任意网页都能驱动本服务：恶意页面的
/// fetch/SSE 会带上自己的 Origin，与本服务主机不一致且不在白名单即 403，
/// 挡掉「访客浏览器代替攻击者打内网/本地接口」这类 drive-by 调用。
/// 非浏览器客户端（Zotero 插件、脚本、pipeline worker）不带 Origin，
/// 原样放行；同源请求的 Origin 与 Host 一致，也放行。
///
/// 挂在 CorsLayer 外侧：被拒请求在 CORS 头注入前就 403，浏览器侧
/// 拿到的是无 CORS 头的失败响应，跨域读不到任何内容。
pub async fn origin_gate(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let Some(origin) = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(next.run(request).await);
    };

    if origin_allowed(origin, request.headers(), &state.config.allowed_origins) {
        return Ok(next.run(request).await);
    }
    Err(AppError::forbidden("browser origin is not allowed"))
}

/// Origin 判定：与 `Host` 同主机或命中白名单即放行。
fn origin_allowed(origin: &str, headers: &HeaderMap, allowlist: &[String]) -> bool {
    let Some(origin_host) = origin_authority(origin) else {
        // 解析不了的 Origin（如 sandboxed iframe 发的 "null"）按原串比对，
        // 需要时可在白名单里显式放行。
        return allowlist.iter().any(|allowed| allowed.eq_ignore_ascii_case(origin));
    };
    if request_authority(headers).is_some_and(|host| host == origin_host) {
        return true;
    }
    allowlist
        .iter()
        .filter_map(|allowed| origin_authority(allowed))
        .any(|allowed| allowed == origin_host)
}

/// 从 Origin 里取 `host[:port]` 权威段，统一小写并剥掉默认端口。
/// 解析不出权威段（无 scheme、空 host、"null"）返回 None。
fn origin_authority(origin: &str) -> Option<String> {
    let (scheme, rest) = origin.split_once("://")?;
    if scheme.is_empty() || rest.is_empty() {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    Some(normalize_authority(authority))
}

/// 请求侧权威段：只信 `Host`。浏览器把 Host 绑定为真实目标地址、且
/// fetch 禁止脚本覆盖它，所以「Origin 与 Host 判等」两侧都不可伪造。
/// 不用 `X-Forwarded-Host`——它不在浏览器禁止伪造的头名单里，直连场景
/// 会被攻击页随意注入。本仓库的反代模板（nginx `proxy_set_header Host
/// $host`）会端到端保留原始主机名，改写 Host 的自备反代走白名单。
/// 没有 Host（理论上 HTTP/1.1 不会发生）返回 None，只走白名单。
fn request_authority(headers: &HeaderMap) -> Option<String> {
    let authority = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(normalize_authority(authority))
}

/// 统一小写并剥掉默认端口，让 `https://example.com` 与 `Host:
/// example.com:443` 判等。非默认端口原样保留。
fn normalize_authority(authority: &str) -> String {
    let lowered = authority.to_ascii_lowercase();
    for default_port in [":80", ":443"] {
        if let Some(stripped) = lowered.strip_suffix(default_port) {
            return stripped.to_string();
        }
    }
    lowered
}
