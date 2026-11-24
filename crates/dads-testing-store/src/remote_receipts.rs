//! Pluggable L2 remote receipt client (`file://`, `http://`, `https://`, and `s3://`).
//!
//! Enforces the fail-closed guarantees verified in `specs/dad-test/remote_receipts_and_env.qnt`:
//! - Any unreachable endpoint, timeout, non-200 response, oversized payload, or malformed key
//!   returns `None` on lookup and silently skips upload, never poisoning local runs or failing tests.
//! - Callers still verify schema version, `passed == true`, and embedded `key == requested_key`
//!   before accepting any downloaded payload.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const IO_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RECEIPT_BYTES: usize = 4 * 1024 * 1024;

static REMOTE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub(crate) enum RemoteReceiptClient {
    FileDir(PathBuf),
    Http {
        host: String,
        port: u16,
        prefix: String,
        token: Option<String>,
    },
    Https {
        base_url: String,
        token: Option<String>,
    },
    S3 {
        bucket: String,
        prefix: String,
    },
}

impl RemoteReceiptClient {
    pub(crate) fn from_url(url: &str, token: Option<String>) -> Option<Self> {
        let trimmed = url.trim().trim_end_matches('/');
        if let Some(path) = trimmed.strip_prefix("file://") {
            if path.is_empty() {
                return None;
            }
            return Some(Self::FileDir(PathBuf::from(path)));
        }
        if let Some(rest) = trimmed.strip_prefix("s3://") {
            let (bucket, prefix) = parse_s3_location(rest)?;
            return Some(Self::S3 { bucket, prefix });
        }
        if let Some(rest) = trimmed.strip_prefix("http://") {
            let (authority, prefix) = match rest.find('/') {
                Some(idx) => (&rest[..idx], rest[idx..].trim_end_matches('/').to_owned()),
                None => (rest, String::new()),
            };
            let (host, port) = parse_authority(authority, 80)?;
            return Some(Self::Http {
                host,
                port,
                prefix,
                token,
            });
        }
        if trimmed.starts_with("https://") && trimmed.len() > "https://".len() {
            return Some(Self::Https {
                base_url: trimmed.to_owned(),
                token,
            });
        }
        None
    }

    pub(crate) fn get(&self, key: &str) -> Option<Vec<u8>> {
        if !is_valid_hex_key(key) {
            return None;
        }
        match self {
            Self::FileDir(dir) => fs::read(dir.join(format!("{key}.json"))).ok(),
            Self::Http {
                host,
                port,
                prefix,
                token,
            } => http_get(host, *port, prefix, key, token.as_deref()),
            Self::Https { base_url, token } => https_get(base_url, key, token.as_deref()),
            Self::S3 { bucket, prefix } => s3_get(bucket, prefix, key),
        }
    }

    pub(crate) fn put(&self, key: &str, payload: &[u8]) {
        if !is_valid_hex_key(key) || payload.len() > MAX_RECEIPT_BYTES {
            return;
        }
        match self {
            Self::FileDir(dir) => file_put(dir, key, payload),
            Self::Http {
                host,
                port,
                prefix,
                token,
            } => http_put(host, *port, prefix, key, payload, token.as_deref()),
            Self::Https { base_url, token } => https_put(base_url, key, payload, token.as_deref()),
            Self::S3 { bucket, prefix } => s3_put(bucket, prefix, key, payload),
        }
    }
}

fn is_valid_hex_key(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    if authority.is_empty() {
        return None;
    }
    if let Some((host, port_str)) = authority.rsplit_once(':') {
        let port = port_str.parse::<u16>().ok()?;
        if host.is_empty() {
            return None;
        }
        Some((host.to_owned(), port))
    } else {
        Some((authority.to_owned(), default_port))
    }
}

fn file_put(dir: &PathBuf, key: &str, payload: &[u8]) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let nonce = REMOTE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = dir.join(format!(".{key}.{}.{nonce}.tmp", std::process::id()));
    let final_path = dir.join(format!("{key}.json"));
    if fs::write(&temp, payload).is_err() {
        let _ = fs::remove_file(&temp);
        return;
    }
    if fs::rename(&temp, &final_path).is_err() {
        let _ = fs::remove_file(&temp);
    }
}

fn connect_http(host: &str, port: u16) -> Option<TcpStream> {
    let addrs = (host, port).to_socket_addrs().ok()?;
    for addr in addrs {
        if let Ok(stream) = TcpStream::connect_timeout(&addr, IO_TIMEOUT) {
            let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
            let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
            return Some(stream);
        }
    }
    None
}

fn http_get(
    host: &str,
    port: u16,
    prefix: &str,
    key: &str,
    token: Option<&str>,
) -> Option<Vec<u8>> {
    let mut stream = connect_http(host, port)?;
    let path = format!("{prefix}/{key}.json");
    let mut request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n"
    );
    if let Some(bearer) = token {
        request.push_str(&format!("Authorization: Bearer {bearer}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).ok()?;

    let mut raw = Vec::new();
    let mut reader = stream.take((MAX_RECEIPT_BYTES + 16 * 1024) as u64);
    reader.read_to_end(&mut raw).ok()?;
    parse_http_ok_body(&raw)
}

fn http_put(host: &str, port: u16, prefix: &str, key: &str, payload: &[u8], token: Option<&str>) {
    let Some(mut stream) = connect_http(host, port) else {
        return;
    };
    let path = format!("{prefix}/{key}.json");
    let mut header = format!(
        "PUT {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        payload.len()
    );
    if let Some(bearer) = token {
        header.push_str(&format!("Authorization: Bearer {bearer}\r\n"));
    }
    header.push_str("\r\n");
    if stream.write_all(header.as_bytes()).is_err() || stream.write_all(payload).is_err() {
        return;
    }
    let mut sink = [0_u8; 256];
    let _ = stream.read(&mut sink);
}

fn parse_http_ok_body(raw: &[u8]) -> Option<Vec<u8>> {
    let split = raw.windows(4).position(|window| window == b"\r\n\r\n")?;
    let header_text = std::str::from_utf8(&raw[..split]).ok()?;
    let status_line = header_text.lines().next()?;
    let status_code = status_line.split_whitespace().nth(1)?;
    if status_code != "200" {
        return None;
    }
    let body = &raw[split + 4..];
    let is_chunked = header_text.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    if is_chunked {
        decode_chunked_body(body)
    } else if body.len() <= MAX_RECEIPT_BYTES {
        Some(body.to_vec())
    } else {
        None
    }
}

fn decode_chunked_body(mut remaining: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let crlf = remaining.windows(2).position(|w| w == b"\r\n")?;
        let size_line = std::str::from_utf8(&remaining[..crlf]).ok()?.trim();
        let size_hex = size_line.split(';').next()?.trim();
        let size = usize::from_str_radix(size_hex, 16).ok()?;
        remaining = &remaining[crlf + 2..];
        if size == 0 {
            return Some(out);
        }
        if remaining.len() < size + 2 || out.len().saturating_add(size) > MAX_RECEIPT_BYTES {
            return None;
        }
        out.extend_from_slice(&remaining[..size]);
        if &remaining[size..size + 2] != b"\r\n" {
            return None;
        }
        remaining = &remaining[size + 2..];
    }
}

fn https_get(base_url: &str, key: &str, token: Option<&str>) -> Option<Vec<u8>> {
    let mut command = Command::new("curl");
    command.args(["--silent", "--show-error", "--fail", "--max-time", "5"]);
    if let Some(bearer) = token {
        command.args(["-H", &format!("Authorization: Bearer {bearer}")]);
    }
    command.arg(format!("{base_url}/{key}.json"));
    let output = command.output().ok()?;
    if !output.status.success() || output.stdout.len() > MAX_RECEIPT_BYTES {
        return None;
    }
    Some(output.stdout)
}

fn https_put(base_url: &str, key: &str, payload: &[u8], token: Option<&str>) {
    let mut command = Command::new("curl");
    command
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--max-time",
            "5",
            "-X",
            "PUT",
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(bearer) = token {
        command.args(["-H", &format!("Authorization: Bearer {bearer}")]);
    }
    command.arg(format!("{base_url}/{key}.json"));
    let Ok(mut child) = command.spawn() else {
        return;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload);
    }
    let _ = child.wait();
}

pub(crate) fn parse_s3_location(rest: &str) -> Option<(String, String)> {
    let (bucket, raw_prefix) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx + 1..]),
        None => (rest, ""),
    };
    if bucket.is_empty()
        || !bucket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
    {
        return None;
    }
    let prefix = raw_prefix.trim_matches('/');
    if !prefix.is_empty()
        && prefix.split('/').any(|segment| {
            segment.is_empty()
                || segment == "."
                || segment == ".."
                || segment
                    .bytes()
                    .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        })
    {
        return None;
    }
    Some((bucket.to_owned(), prefix.to_owned()))
}

fn s3_object_uri(bucket: &str, prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        format!("s3://{bucket}/{key}.json")
    } else {
        format!("s3://{bucket}/{prefix}/{key}.json")
    }
}

fn s3_aws_command() -> Command {
    let executable = std::env::var("DADS_TESTING_AWS_CLI")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "aws".to_owned());
    let mut command = Command::new(executable);
    command
        .env("AWS_CLI_AUTO_PROMPT", "off")
        .env("AWS_PAGER", "");
    command
}

fn s3_get(bucket: &str, prefix: &str, key: &str) -> Option<Vec<u8>> {
    let uri = s3_object_uri(bucket, prefix, key);
    let output = s3_aws_command()
        .args([
            "s3",
            "cp",
            &uri,
            "-",
            "--only-show-errors",
            "--cli-read-timeout",
            "5",
            "--cli-connect-timeout",
            "3",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() > MAX_RECEIPT_BYTES {
        return None;
    }
    Some(output.stdout)
}

fn s3_put(bucket: &str, prefix: &str, key: &str, payload: &[u8]) {
    let uri = s3_object_uri(bucket, prefix, key);
    let Ok(mut child) = s3_aws_command()
        .args([
            "s3",
            "cp",
            "-",
            &uri,
            "--content-type",
            "application/json",
            "--only-show-errors",
            "--cli-read-timeout",
            "5",
            "--cli-connect-timeout",
            "3",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload);
    }
    let _ = child.wait();
}
