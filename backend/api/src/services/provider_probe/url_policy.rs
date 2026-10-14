use std::net::IpAddr;

use url::Host;

use crate::error::AppError;
use crate::services::net_policy::is_public_ip;

/// Validate a client-supplied provider URL before it carries a bearer token.
/// This prevents probe endpoints from becoming SSRF or credential-exfiltration
/// primitives. Self-hosted deployments can explicitly allow private targets,
/// or whitelist specific hosts via `allowed_hosts` (tailscale/内网自建网关的
/// 推荐姿势——精确放行,其余私网照常拒绝)。
pub(super) fn validate_provider_base_url(
    raw_base_url: &str,
    allow_private_urls: bool,
    allowed_hosts: &[String],
) -> Result<(), AppError> {
    let trimmed = raw_base_url.trim();
    let parsed = url::Url::parse(trimmed)
        .map_err(|_| AppError::bad_request("base_url must be a valid absolute http(s) URL"))?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::bad_request(
            "base_url scheme must be http or https",
        ));
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::bad_request(
            "base_url must not contain embedded credentials",
        ));
    }

    if allow_private_urls {
        return Ok(());
    }

    let host = match parsed.host() {
        Some(host) => host,
        None => {
            return Err(AppError::bad_request("base_url must include a host"));
        }
    };

    // 部署者钦定的主机(IP 字面量或域名)跳过私网段检查;归一到小写字符串比较
    let host_string = match &host {
        Host::Domain(domain) => domain.to_ascii_lowercase(),
        Host::Ipv4(ip) => ip.to_string(),
        Host::Ipv6(ip) => ip.to_string(),
    };
    if allowed_hosts.iter().any(|h| h == &host_string) {
        return Ok(());
    }

    match host {
        Host::Domain(domain) => {
            if domain.eq_ignore_ascii_case("localhost") {
                return Err(AppError::bad_request(
                    "base_url host is not allowed; localhost/private targets are blocked",
                ));
            }
        }
        // 与连接钉扎端共用同一份公网判定(is_public_ip),静态校验与
        // 实际连接两端一致——此前这里漏了 CGNAT(100.64/10)等段,静态放行、
        // 连接才拦,400 晚到且文案对不上(2026-10-14 体检发现)。
        Host::Ipv4(ip) => {
            if !is_public_ip(IpAddr::V4(ip)) {
                return Err(AppError::bad_request(
                    "base_url host is not allowed; loopback/private/link-local IPs are blocked",
                ));
            }
        }
        Host::Ipv6(ip) => {
            if !is_public_ip(IpAddr::V6(ip)) {
                return Err(AppError::bad_request(
                    "base_url host is not allowed; loopback/private/link-local IPs are blocked",
                ));
            }
        }
    }

    Ok(())
}
