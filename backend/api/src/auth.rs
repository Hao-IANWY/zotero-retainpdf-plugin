use axum::body::Body;
use axum::http::{Method, Request};
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
        .map(|key| deps.api_keys.contains(key))
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
