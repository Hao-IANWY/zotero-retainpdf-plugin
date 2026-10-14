//! 模型执行器与供应商探针共用的出站网络策略:公网地址校验、DNS 解析钉扎、
//! 探针响应体限额。策略必须在「静态校验」和「实际连接」两端一致,避免
//! 检测通过、执行失败(或反向)的窗口。

use std::net::{IpAddr, SocketAddr};

/// 仅放行全局单播公网地址(含文档网段在内的保留/私有/回环全部拒绝)。
pub(crate) fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0)
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|v| is_public_ip(IpAddr::V4(v)))
            .unwrap_or_else(|| {
                let s = ip.segments();
                // Only global unicast; exclude documentation space.
                s[0] & 0xe000 == 0x2000 && !(s[0] == 0x2001 && s[1] == 0xdb8)
            }),
    }
}

#[derive(Debug)]
pub(crate) enum ResolveError {
    /// DNS 解析本身失败(网络不可达、域名不存在等),按瞬时错误处理。
    Dns(String),
    /// 解析结果含保留/私有地址且未显式放行,属策略拒绝。
    Policy,
}

/// 解析主机的**全部**地址并校验;任一地址落在保留/私有网段且未显式放行
/// 即拒绝。返回的地址列表供 reqwest `resolve_to_addrs` 钉扎,堵住「校验
/// 时公网、连接时被 rebinding 到内网」的窗口。
/// 白名单(allowed_hosts)内的主机跳过公网校验,但地址钉扎照旧——
/// 名单是部署者对「这个主机是我自己的」的显式背书,不代表放弃防 rebinding。
pub(crate) async fn resolve_pinned_addresses(
    host: &str,
    port: u16,
    allow_private: bool,
    allowed_hosts: &[String],
) -> Result<Vec<SocketAddr>, ResolveError> {
    let addresses: Vec<_> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| ResolveError::Dns(error.to_string()))?
        .collect();
    if addresses.is_empty() {
        return Err(ResolveError::Dns("no addresses resolved".to_string()));
    }
    let whitelisted = allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(host));
    if !allow_private
        && !whitelisted
        && addresses.iter().any(|a| !is_public_ip(a.ip()))
    {
        return Err(ResolveError::Policy);
    }
    Ok(addresses)
}

/// 探针响应体读取上限:错误正文与模型列表都不需要更大。
pub(crate) const PROBE_BODY_CAP: usize = 1024 * 1024;

/// 读取响应体,超过 `cap` 即截断。探针只做分类,不需要完整正文;
/// 不设上限会让恶意/异常端点把探针变成内存放大器。
pub(crate) async fn read_body_capped(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<String, reqwest::Error> {
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let remaining = cap.saturating_sub(body.len());
        if remaining == 0 {
            break;
        }
        let take = remaining.min(chunk.len());
        body.extend_from_slice(&chunk[..take]);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}
