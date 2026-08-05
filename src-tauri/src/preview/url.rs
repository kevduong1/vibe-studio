pub(crate) fn normalize_loopback_url(input: &str) -> Result<url::Url, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Enter a localhost URL or port".into());
    }
    let candidate = if raw.bytes().all(|b| b.is_ascii_digit()) {
        format!("http://localhost:{raw}")
    } else if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let url = url::Url::parse(&candidate).map_err(|_| "Invalid preview URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || !is_loopback_url(&url) {
        return Err("Preview URLs must use HTTP or HTTPS on localhost".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Preview URLs cannot contain credentials".into());
    }
    Ok(url)
}

pub(crate) fn is_loopback_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_port_and_host_shorthand() {
        assert_eq!(
            normalize_loopback_url("3000").unwrap().as_str(),
            "http://localhost:3000/"
        );
        assert_eq!(
            normalize_loopback_url("localhost:8081/app")
                .unwrap()
                .as_str(),
            "http://localhost:8081/app"
        );
    }

    #[test]
    fn accepts_only_loopback_http_urls() {
        for input in [
            "http://localhost:3000",
            "https://127.0.0.1:4443/path",
            "http://[::1]:8081",
        ] {
            assert!(normalize_loopback_url(input).is_ok(), "{input}");
        }
        for input in [
            "file:///tmp/index.html",
            "http://localhost.example.com:3000",
            "http://192.168.1.4:3000",
            "http://user:pass@localhost:3000",
        ] {
            assert!(normalize_loopback_url(input).is_err(), "{input}");
        }
    }
}
