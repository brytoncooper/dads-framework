//! Pluggable L2 remote receipt client (`file://`, `http://`, `https://`, and `s3://`).
//!
//! Enforces the fail-closed guarantees verified in `specs/dad-test/remote_receipts_and_env.qnt`:
//! - Any unreachable endpoint, timeout, non-200 response, oversized payload, or malformed key
//!   returns `None` on lookup and silently skips upload, never poisoning local runs or failing tests.
//! - Callers still verify schema version, `passed == true`, and embedded `key == requested_key`
//!   before accepting any downloaded payload.

use crate::s3_client::NativeS3Client;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const GLOBAL_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RECEIPT_BYTES: usize = 4 * 1024 * 1024;
const DRAIN_LIMIT_BYTES: u64 = 64 * 1024;

static REMOTE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub(crate) enum RemoteReceiptClient {
    FileDir(PathBuf),
    Http {
        base_url: String,
        token: Option<String>,
        agent: ureq::Agent,
    },
    S3(NativeS3Client),
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
            return Some(Self::S3(NativeS3Client::new(bucket, prefix)));
        }
        if let Some(rest) = trimmed
            .strip_prefix("http://")
            .or_else(|| trimmed.strip_prefix("https://"))
        {
            if rest.is_empty() {
                return None;
            }
            let authority = rest.split('/').next().unwrap_or("");
            if authority.is_empty() || authority.starts_with(':') {
                return None;
            }
            return Some(Self::Http {
                base_url: trimmed.to_owned(),
                token,
                agent: build_http_agent(),
            });
        }
        None
    }

    pub(crate) fn begin_run(&self) {
        if let Self::S3(client) = self {
            client.begin_run();
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<Vec<u8>> {
        if !is_valid_hex_key(key) {
            return None;
        }
        match self {
            Self::FileDir(dir) => fs::read(dir.join(format!("{key}.json"))).ok(),
            Self::Http {
                base_url,
                token,
                agent,
            } => http_get(agent, base_url, key, token.as_deref()),
            Self::S3(client) => client.get(key, MAX_RECEIPT_BYTES),
        }
    }

    pub(crate) fn put(&self, key: &str, payload: &[u8]) {
        if !is_valid_hex_key(key) || payload.len() > MAX_RECEIPT_BYTES {
            return;
        }
        match self {
            Self::FileDir(dir) => file_put(dir, key, payload),
            Self::Http {
                base_url,
                token,
                agent,
            } => http_put(agent, base_url, key, payload, token.as_deref()),
            Self::S3(client) => client.put(key, payload),
        }
    }
}

fn build_http_agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_idle_connections(32)
        .max_idle_connections_per_host(16)
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_global(Some(GLOBAL_TIMEOUT))
        .build();
    config.into()
}

fn is_valid_hex_key(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn file_put(dir: &PathBuf, key: &str, payload: &[u8]) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let counter = REMOTE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = dir.join(format!(".{key}.{}.{counter}.tmp", std::process::id()));
    let final_path = dir.join(format!("{key}.json"));
    if fs::write(&temp, payload).is_err() {
        let _ = fs::remove_file(&temp);
        return;
    }
    if fs::rename(&temp, &final_path).is_err() {
        let _ = fs::remove_file(&temp);
    }
}

fn http_get(
    agent: &ureq::Agent,
    base_url: &str,
    key: &str,
    token: Option<&str>,
) -> Option<Vec<u8>> {
    let url = format!("{base_url}/{key}.json");
    let mut request = agent.get(&url);
    if let Some(bearer) = token {
        request = request.header("Authorization", &format!("Bearer {bearer}"));
    }
    let mut response = request.call().ok()?;
    if response.status().as_u16() != 200 {
        let _ = response
            .body_mut()
            .with_config()
            .limit(DRAIN_LIMIT_BYTES)
            .read_to_vec();
        return None;
    }
    let limit = u64::try_from(MAX_RECEIPT_BYTES).ok()?;
    let bytes = response
        .body_mut()
        .with_config()
        .limit(limit)
        .read_to_vec()
        .ok()?;
    if bytes.len() > MAX_RECEIPT_BYTES {
        return None;
    }
    Some(bytes)
}

fn http_put(agent: &ureq::Agent, base_url: &str, key: &str, payload: &[u8], token: Option<&str>) {
    let url = format!("{base_url}/{key}.json");
    let mut request = agent.put(&url).header("Content-Type", "application/json");
    if let Some(bearer) = token {
        request = request.header("Authorization", &format!("Bearer {bearer}"));
    }
    if let Ok(mut response) = request.send(payload) {
        let _ = response
            .body_mut()
            .with_config()
            .limit(DRAIN_LIMIT_BYTES)
            .read_to_vec();
    }
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
