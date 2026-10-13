//! 浏览器 Origin 门禁（`auth::origin_gate`）的行为测试。
//!
//! 门禁的语义边界：无 Origin 放行（非浏览器客户端）、同主机放行、
//! 白名单放行，其余浏览器来源一律 403——匿名模式不能退化成
//! 「任意网页都能驱动本服务」。

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::util::ServiceExt;

use crate::app::{build_app, build_state};
use crate::test_support::config::TestDirs;

use super::jobs_common::test_state;

async fn get_health(state: &crate::AppState, origin: Option<&str>, host: Option<&str>) -> StatusCode {
    let app = build_app(state.clone());
    let mut builder = Request::builder().uri("/health");
    if let Some(origin) = origin {
        builder = builder.header("Origin", origin);
    }
    if let Some(host) = host {
        builder = builder.header("Host", host);
    }
    app.oneshot(builder.body(Body::empty()).expect("health request"))
        .await
        .expect("response")
        .status()
}

fn state_with_allowlist(test_name: &str, allowed: &[&str]) -> crate::AppState {
    let dirs = TestDirs::create(&format!(
        "rust-api-origin-gate-{test_name}-{}",
        fastrand::u64(..)
    ));
    let mut config = dirs.config();
    config.allowed_origins = allowed.iter().map(|value| value.to_string()).collect();
    build_state(Arc::new(config)).expect("build state")
}

#[tokio::test]
async fn request_without_origin_is_allowed() {
    // Zotero 插件、脚本、pipeline worker：不带 Origin 的直连不受门禁影响。
    let state = test_state("origin-absent");
    assert_eq!(get_health(&state, None, None).await, StatusCode::OK);
}

#[tokio::test]
async fn same_host_origin_is_allowed() {
    // 同源 POST/fetch 也会带 Origin；与 Host 判等即放行（默认端口可省略）。
    let state = test_state("origin-same-host");
    assert_eq!(
        get_health(&state, Some("http://127.0.0.1:41000"), Some("127.0.0.1:41000")).await,
        StatusCode::OK
    );
    // 浏览器对默认端口会省略，Host 可能带着 :443——两侧归一化后判等。
    assert_eq!(
        get_health(&state, Some("https://retain.example.org"), Some("retain.example.org:443")).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn cross_host_origin_is_rejected() {
    // drive-by 场景：evil.com 的页面驱动访客浏览器打本服务。
    let state = test_state("origin-cross-host");
    assert_eq!(
        get_health(&state, Some("https://evil.example"), Some("127.0.0.1:41000")).await,
        StatusCode::FORBIDDEN
    );
    // 仿冒同主机名但端口不同的来源也不放行。
    assert_eq!(
        get_health(&state, Some("http://127.0.0.1:39999"), Some("127.0.0.1:41000")).await,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn opaque_null_origin_is_rejected_unless_allowlisted() {
    let state = test_state("origin-null");
    assert_eq!(
        get_health(&state, Some("null"), Some("127.0.0.1:41000")).await,
        StatusCode::FORBIDDEN
    );

    let allowlisted = state_with_allowlist("origin-null-allow", &["null"]);
    assert_eq!(
        get_health(&allowlisted, Some("null"), Some("127.0.0.1:41000")).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn allowlisted_origin_is_allowed() {
    // 独立前端部署（vite dev server 等）：白名单放行跨主机来源。
    let state = state_with_allowlist("origin-allowlist", &["http://localhost:5173"]);
    assert_eq!(
        get_health(&state, Some("http://localhost:5173"), Some("127.0.0.1:41000")).await,
        StatusCode::OK
    );
    // 大小写归一：Origin 的 host 大小写不敏感。
    assert_eq!(
        get_health(&state, Some("http://LOCALHOST:5173"), Some("127.0.0.1:41000")).await,
        StatusCode::OK
    );
    assert_eq!(
        get_health(&state, Some("http://localhost:9999"), Some("127.0.0.1:41000")).await,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn forwarded_host_header_is_ignored() {
    // X-Forwarded-Host 不在浏览器禁止伪造的头名单里：攻击页直连本服务时
    // 能带上任意值。门禁只认 Host,伪造的转发头救不了不匹配的 Origin。
    let state = test_state("origin-forwarded");
    let app = build_app(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .header("Origin", "https://evil.example")
                .header("Host", "127.0.0.1:41000")
                .header("X-Forwarded-Host", "evil.example")
                .body(Body::empty())
                .expect("health request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // 反代场景不依赖该头：nginx 模板用 `proxy_set_header Host $host`
    // 端到端保留主机名,后端看到的 Host 就是浏览器 Origin 的权威段。
    let state = test_state("origin-proxied-host");
    let app = build_app(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .header("Origin", "https://retain.example.org")
                .header("Host", "retain.example.org")
                .body(Body::empty())
                .expect("health request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}
