use super::env_vars::{env_optional_string, env_string, env_u16};

#[derive(Clone, Debug)]
pub struct ServerRuntimeConfig {
    pub python_bin: String,
    pub bind_host: String,
    pub port: u16,
    /// 受信浏览器 Origin 白名单（逗号分隔）。匿名模式下这决定「哪些网页
    /// 可以驱动本服务」：带 Origin 且与本服务主机不一致、又不在白名单的
    /// 请求一律 403。不带 Origin 的客户端（Zotero 插件、脚本、worker）不受影响。
    pub allowed_origins: Vec<String>,
}

/// 逗号分隔 → 小写条目列表；空白项丢弃。
fn parse_allowed_origins(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

impl ServerRuntimeConfig {
    pub fn from_env() -> Self {
        Self {
            python_bin: env_string("PYTHON_BIN", "python"),
            // Default to loopback-only: binding 0.0.0.0 by default combined with
            // CorsLayer::permissive() and a single static API key would expose the
            // API to the network unintentionally. Docker deployments need
            // 0.0.0.0 inside the container, so they set RUST_API_BIND_HOST=0.0.0.0
            // explicitly (see docker/delivery/docker/app.env).
            bind_host: env_string("RUST_API_BIND_HOST", "127.0.0.1"),
            port: env_u16("RUST_API_PORT", 41000),
            allowed_origins: env_optional_string("RUST_API_ALLOWED_ORIGINS")
                .map(|value| parse_allowed_origins(&value))
                .unwrap_or_default(),
        }
    }

    pub fn from_desktop(python_bin: String, port: u16) -> Self {
        Self {
            python_bin,
            bind_host: "127.0.0.1".to_string(),
            port,
            // 桌面注入的旧客户端是直连调用，不带浏览器 Origin，白名单留空即可。
            allowed_origins: Vec::new(),
        }
    }
}
