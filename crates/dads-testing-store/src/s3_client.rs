//! Connection-pooled native Rust S3 client (`GET`/`PUT`) with SigV4 signing and `aws` CLI
//! fallback for local SSO/profile setups.
//!
//! Replaces both `s3_index.rs`'s `ListObjectsV2` full-bucket scan and per-task Python `aws s3 cp`
//! subprocesses with direct keep-alive HTTPS requests over a shared `ureq::Agent`.

use crate::s3_credentials::AwsCredentialProvider;
use crate::s3_sigv4::{
    EMPTY_PAYLOAD_SHA256, S3SignRequest, SignedS3Headers, encode_s3_uri_path, sha256_hex,
    sign_s3_request,
};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

const S3_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const S3_GLOBAL_TIMEOUT: Duration = Duration::from_secs(5);
const DRAIN_LIMIT_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct NativeS3Client {
    bucket: String,
    prefix: String,
    agent: ureq::Agent,
    credentials: AwsCredentialProvider,
    #[cfg(test)]
    test_endpoint_override: Option<String>,
    #[cfg(test)]
    test_disable_cli_fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct S3ObjectTarget {
    pub(crate) url: String,
    pub(crate) host: String,
    pub(crate) canonical_uri: String,
}

impl NativeS3Client {
    pub(crate) fn new(bucket: String, prefix: String) -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_idle_connections(32)
            .max_idle_connections_per_host(16)
            .timeout_connect(Some(S3_CONNECT_TIMEOUT))
            .timeout_global(Some(S3_GLOBAL_TIMEOUT))
            .build();
        Self {
            bucket,
            prefix,
            agent: config.into(),
            credentials: AwsCredentialProvider::default(),
            #[cfg(test)]
            test_endpoint_override: None,
            #[cfg(test)]
            test_disable_cli_fallback: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test_endpoints(
        bucket: String,
        prefix: String,
        s3_endpoint: String,
        imds_endpoint: String,
    ) -> Self {
        let mut client = Self::new(bucket, prefix);
        client.credentials = AwsCredentialProvider::for_test_imds(imds_endpoint);
        client.test_endpoint_override = Some(s3_endpoint);
        client.test_disable_cli_fallback = true;
        client
    }

    pub(crate) fn begin_run(&self) {
        self.credentials.clear();
    }

    fn effective_endpoint(&self) -> Option<String> {
        #[cfg(test)]
        if let Some(ep) = &self.test_endpoint_override {
            return Some(ep.clone());
        }
        endpoint_override()
    }

    fn allow_cli_fallback(&self) -> bool {
        #[cfg(test)]
        if self.test_disable_cli_fallback {
            return false;
        }
        true
    }

    pub(crate) fn get(&self, key: &str, max_bytes: usize) -> Option<Vec<u8>> {
        if self.allow_cli_fallback() && force_aws_cli() {
            return s3_cli_get(&self.bucket, &self.prefix, key, max_bytes);
        }
        let custom_endpoint = self.effective_endpoint();
        let Some(creds) = self.credentials.resolve_credentials() else {
            return self
                .allow_cli_fallback()
                .then(|| s3_cli_get(&self.bucket, &self.prefix, key, max_bytes))
                .flatten();
        };
        let Some(region) =
            self.credentials
                .resolve_region(&self.bucket, &self.agent, custom_endpoint.as_deref())
        else {
            return self
                .allow_cli_fallback()
                .then(|| s3_cli_get(&self.bucket, &self.prefix, key, max_bytes))
                .flatten();
        };
        let bucket_key = s3_bucket_key(&self.prefix, key);
        let target = build_s3_target(
            &self.bucket,
            &bucket_key,
            &region,
            custom_endpoint.as_deref(),
        )?;
        let sign_req = S3SignRequest {
            method: "GET",
            host: &target.host,
            canonical_uri: &target.canonical_uri,
            region: &region,
            payload_sha256: EMPTY_PAYLOAD_SHA256,
        };
        let signed = sign_s3_request(&sign_req, &creds, SystemTime::now())?;
        let mut request = self.agent.get(&target.url);
        request = apply_signed_headers(request, &signed);
        let mut response = request.call().ok()?;
        if response.status().as_u16() != 200 {
            drain_for_keepalive(&mut response);
            return None;
        }
        let limit = u64::try_from(max_bytes).ok()?;
        let bytes = response
            .body_mut()
            .with_config()
            .limit(limit)
            .read_to_vec()
            .ok()?;
        if bytes.len() > max_bytes {
            return None;
        }
        Some(bytes)
    }

    pub(crate) fn put(&self, key: &str, payload: &[u8]) {
        if self.allow_cli_fallback() && force_aws_cli() {
            s3_cli_put(&self.bucket, &self.prefix, key, payload);
            return;
        }
        let custom_endpoint = self.effective_endpoint();
        let Some(creds) = self.credentials.resolve_credentials() else {
            if self.allow_cli_fallback() {
                s3_cli_put(&self.bucket, &self.prefix, key, payload);
            }
            return;
        };
        let Some(region) =
            self.credentials
                .resolve_region(&self.bucket, &self.agent, custom_endpoint.as_deref())
        else {
            if self.allow_cli_fallback() {
                s3_cli_put(&self.bucket, &self.prefix, key, payload);
            }
            return;
        };
        let bucket_key = s3_bucket_key(&self.prefix, key);
        let Some(target) = build_s3_target(
            &self.bucket,
            &bucket_key,
            &region,
            custom_endpoint.as_deref(),
        ) else {
            return;
        };
        let payload_hash = sha256_hex(payload);
        let sign_req = S3SignRequest {
            method: "PUT",
            host: &target.host,
            canonical_uri: &target.canonical_uri,
            region: &region,
            payload_sha256: &payload_hash,
        };
        let Some(signed) = sign_s3_request(&sign_req, &creds, SystemTime::now()) else {
            return;
        };
        let mut request = self
            .agent
            .put(&target.url)
            .header("Content-Type", "application/json");
        request = apply_signed_headers(request, &signed);
        if let Ok(mut response) = request.send(payload) {
            drain_for_keepalive(&mut response);
        }
    }
}

fn apply_signed_headers<B>(
    request: ureq::RequestBuilder<B>,
    signed: &SignedS3Headers,
) -> ureq::RequestBuilder<B> {
    let request = request
        .header("Host", &signed.host)
        .header("x-amz-date", &signed.amz_date)
        .header("x-amz-content-sha256", &signed.content_sha256)
        .header("Authorization", &signed.authorization);
    match signed.session_token.as_deref() {
        Some(token) => request.header("x-amz-security-token", token),
        None => request,
    }
}

fn drain_for_keepalive(response: &mut ureq::http::Response<ureq::Body>) {
    let _ = response
        .body_mut()
        .with_config()
        .limit(DRAIN_LIMIT_BYTES)
        .read_to_vec();
}

pub(crate) fn build_s3_target(
    bucket: &str,
    bucket_key: &str,
    region: &str,
    custom_endpoint: Option<&str>,
) -> Option<S3ObjectTarget> {
    if let Some(endpoint) = custom_endpoint {
        let trimmed = endpoint.trim().trim_end_matches('/');
        let (scheme, rest) = trimmed.split_once("://")?;
        if scheme != "http" && scheme != "https" {
            return None;
        }
        let (authority, base_path) = match rest.find('/') {
            Some(idx) => (&rest[..idx], rest[idx..].trim_end_matches('/')),
            None => (rest, ""),
        };
        if authority.is_empty() {
            return None;
        }
        let raw_path = if base_path.is_empty() {
            format!("/{bucket}/{bucket_key}")
        } else {
            format!("{base_path}/{bucket}/{bucket_key}")
        };
        let canonical_uri = encode_s3_uri_path(&raw_path);
        return Some(S3ObjectTarget {
            url: format!("{scheme}://{authority}{canonical_uri}"),
            host: authority.to_owned(),
            canonical_uri,
        });
    }
    let host = format!("{bucket}.s3.{region}.amazonaws.com");
    let canonical_uri = encode_s3_uri_path(&format!("/{bucket_key}"));
    Some(S3ObjectTarget {
        url: format!("https://{host}{canonical_uri}"),
        host,
        canonical_uri,
    })
}

fn endpoint_override() -> Option<String> {
    env_non_empty("AWS_ENDPOINT_URL_S3").or_else(|| env_non_empty("AWS_ENDPOINT_URL"))
}

fn force_aws_cli() -> bool {
    env_non_empty("DADS_TESTING_AWS_CLI").is_some()
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn s3_bucket_key(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        format!("{key}.json")
    } else {
        format!("{prefix}/{key}.json")
    }
}

fn s3_object_uri(bucket: &str, prefix: &str, key: &str) -> String {
    format!("s3://{bucket}/{}", s3_bucket_key(prefix, key))
}

fn s3_aws_command() -> Command {
    let executable = env_non_empty("DADS_TESTING_AWS_CLI").unwrap_or_else(|| "aws".to_owned());
    let mut command = Command::new(executable);
    command
        .env("AWS_CLI_AUTO_PROMPT", "off")
        .env("AWS_PAGER", "");
    command
}

fn s3_cli_get(bucket: &str, prefix: &str, key: &str, max_bytes: usize) -> Option<Vec<u8>> {
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
    if !output.status.success() || output.stdout.len() > max_bytes {
        return None;
    }
    Some(output.stdout)
}

fn s3_cli_put(bucket: &str, prefix: &str, key: &str, payload: &[u8]) {
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
