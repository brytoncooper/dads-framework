//! Native AWS credential and region resolution for S3 receipt caching.
//!
//! Resolves credentials once per run in standard AWS priority order:
//! 1. Static/session environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`)
//! 2. ECS container credentials (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `FULL_URI`)
//! 3. EC2 IMDSv2 (`http://169.254.169.254/latest/...` or `AWS_EC2_METADATA_SERVICE_ENDPOINT`)
//!
//! All network probes are bounded with sub-second connect timeouts and cached in memory (including
//! negative probes) so non-EC2 environments never stall and EC2 runners fetch IMDSv2 once per run.

use crate::s3_sigv4::{SigV4Credentials, days_from_civil};
use serde::Deserialize;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_IMDS_ENDPOINT: &str = "http://169.254.169.254";
const ECS_METADATA_HOST: &str = "http://169.254.170.2";
const IMDS_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const IMDS_GLOBAL_TIMEOUT: Duration = Duration::from_millis(1_500);
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const CREDENTIAL_REFRESH_MARGIN: Duration = Duration::from_secs(300);
const FALLBACK_CREDENTIAL_TTL: Duration = Duration::from_secs(900);

#[derive(Debug, Clone)]
pub(crate) struct AwsCredentialProvider {
    metadata_agent: ureq::Agent,
    state: Arc<Mutex<ProviderState>>,
    #[cfg(test)]
    test_imds_endpoint: Option<String>,
    #[cfg(test)]
    test_ignore_env: bool,
}

#[derive(Debug, Default)]
struct ProviderState {
    cached_creds: Option<CachedCredentials>,
    imds_unavailable: bool,
    ecs_unavailable: bool,
    cached_region: Option<String>,
    region_probe_failed: bool,
}

#[derive(Debug, Clone)]
struct CachedCredentials {
    creds: SigV4Credentials,
    expires_at: Option<SystemTime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct MetadataCredentialsResponse {
    access_key_id: String,
    secret_access_key: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    expiration: Option<String>,
}

impl Default for AwsCredentialProvider {
    fn default() -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_idle_connections(4)
            .max_idle_connections_per_host(2)
            .timeout_connect(Some(IMDS_CONNECT_TIMEOUT))
            .timeout_global(Some(IMDS_GLOBAL_TIMEOUT))
            .build();
        Self {
            metadata_agent: config.into(),
            state: Arc::new(Mutex::new(ProviderState::default())),
            #[cfg(test)]
            test_imds_endpoint: None,
            #[cfg(test)]
            test_ignore_env: false,
        }
    }
}

impl AwsCredentialProvider {
    #[cfg(test)]
    pub(crate) fn for_test_imds(imds_endpoint: String) -> Self {
        Self {
            test_imds_endpoint: Some(imds_endpoint.trim_end_matches('/').to_owned()),
            test_ignore_env: true,
            ..Self::default()
        }
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut guard) = self.state.lock() {
            *guard = ProviderState::default();
        }
    }

    fn effective_imds_endpoint(&self) -> String {
        #[cfg(test)]
        if let Some(ep) = &self.test_imds_endpoint {
            return ep.clone();
        }
        imds_endpoint()
    }

    fn allow_env(&self) -> bool {
        #[cfg(test)]
        if self.test_ignore_env {
            return false;
        }
        true
    }

    pub(crate) fn resolve_credentials(&self) -> Option<SigV4Credentials> {
        if self.allow_env()
            && let Some(env_creds) = env_credentials()
        {
            return Some(env_creds);
        }
        let mut guard = self.state.lock().ok()?;
        let now = SystemTime::now();
        if let Some(cached) = &guard.cached_creds
            && is_still_fresh(cached.expires_at, now)
        {
            return Some(cached.creds.clone());
        }
        if self.allow_env()
            && !guard.ecs_unavailable
            && let Some(ecs) = fetch_ecs_credentials(&self.metadata_agent)
        {
            let creds = ecs.creds.clone();
            guard.cached_creds = Some(ecs);
            return Some(creds);
        }
        if self.allow_env() && ecs_env_present() {
            guard.ecs_unavailable = true;
        }
        let allow_imds = !self.allow_env() || !imds_disabled();
        if !guard.imds_unavailable && allow_imds {
            let base = self.effective_imds_endpoint();
            if let Some((imds_creds, maybe_region)) =
                fetch_imds_credentials(&self.metadata_agent, &base)
            {
                let creds = imds_creds.creds.clone();
                guard.cached_creds = Some(imds_creds);
                if guard.cached_region.is_none() {
                    guard.cached_region = maybe_region;
                }
                return Some(creds);
            }
            guard.imds_unavailable = true;
        }
        None
    }

    pub(crate) fn resolve_region(
        &self,
        bucket: &str,
        s3_agent: &ureq::Agent,
        custom_endpoint: Option<&str>,
    ) -> Option<String> {
        if self.allow_env()
            && let Some(env_region) = env_region()
        {
            return Some(env_region);
        }
        let mut guard = self.state.lock().ok()?;
        if let Some(region) = &guard.cached_region {
            return Some(region.clone());
        }
        let allow_imds = !self.allow_env() || !imds_disabled();
        if !guard.imds_unavailable && allow_imds {
            let base = self.effective_imds_endpoint();
            if let Some(token) = fetch_imds_token(&self.metadata_agent, &base)
                && let Some(region) = fetch_imds_region(&self.metadata_agent, &base, &token)
            {
                guard.cached_region = Some(region.clone());
                return Some(region);
            }
        }
        if custom_endpoint.is_some() {
            let default = "us-east-1".to_owned();
            guard.cached_region = Some(default.clone());
            return Some(default);
        }
        if !guard.region_probe_failed {
            if let Some(region) = probe_bucket_region(s3_agent, bucket) {
                guard.cached_region = Some(region.clone());
                return Some(region);
            }
            guard.region_probe_failed = true;
        }
        None
    }
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn env_credentials() -> Option<SigV4Credentials> {
    let access_key_id = env_non_empty("AWS_ACCESS_KEY_ID")?;
    let secret_access_key = env_non_empty("AWS_SECRET_ACCESS_KEY")?;
    let session_token = env_non_empty("AWS_SESSION_TOKEN");
    Some(SigV4Credentials {
        access_key_id,
        secret_access_key,
        session_token,
    })
}

fn env_region() -> Option<String> {
    env_non_empty("AWS_REGION").or_else(|| env_non_empty("AWS_DEFAULT_REGION"))
}

fn imds_disabled() -> bool {
    env_non_empty("AWS_EC2_METADATA_DISABLED")
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
}

fn imds_endpoint() -> String {
    env_non_empty("AWS_EC2_METADATA_SERVICE_ENDPOINT")
        .map(|value| value.trim_end_matches('/').to_owned())
        .unwrap_or_else(|| DEFAULT_IMDS_ENDPOINT.to_owned())
}

fn ecs_env_present() -> bool {
    env_non_empty("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI").is_some()
        || env_non_empty("AWS_CONTAINER_CREDENTIALS_FULL_URI").is_some()
}

fn fetch_ecs_credentials(agent: &ureq::Agent) -> Option<CachedCredentials> {
    let url = if let Some(rel) = env_non_empty("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") {
        let path = if rel.starts_with('/') {
            rel
        } else {
            format!("/{rel}")
        };
        format!("{ECS_METADATA_HOST}{path}")
    } else {
        env_non_empty("AWS_CONTAINER_CREDENTIALS_FULL_URI")?
    };
    let mut request = agent.get(&url);
    if let Some(auth) = ecs_authorization_token() {
        request = request.header("Authorization", &auth);
    }
    let mut response = request.call().ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_METADATA_BYTES)
        .read_to_vec()
        .ok()?;
    parse_metadata_credentials(&body)
}

fn ecs_authorization_token() -> Option<String> {
    if let Some(file) = env_non_empty("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE") {
        return fs::read_to_string(file)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
    }
    env_non_empty("AWS_CONTAINER_AUTHORIZATION_TOKEN")
}

fn fetch_imds_credentials(
    agent: &ureq::Agent,
    base: &str,
) -> Option<(CachedCredentials, Option<String>)> {
    let token = fetch_imds_token(agent, base)?;
    let roles_url = format!("{base}/latest/meta-data/iam/security-credentials/");
    let roles_body = imds_get_text(agent, &roles_url, &token)?;
    let role = roles_body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let creds_url = format!("{base}/latest/meta-data/iam/security-credentials/{role}");
    let creds_bytes = imds_get_bytes(agent, &creds_url, &token)?;
    let creds = parse_metadata_credentials(&creds_bytes)?;
    let region = fetch_imds_region(agent, base, &token);
    Some((creds, region))
}

fn fetch_imds_token(agent: &ureq::Agent, base: &str) -> Option<String> {
    let url = format!("{base}/latest/api/token");
    let mut response = agent
        .put(&url)
        .header("X-aws-ec2-metadata-token-ttl-seconds", "21600")
        .send_empty()
        .ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_METADATA_BYTES)
        .read_to_vec()
        .ok()?;
    let token = String::from_utf8(bytes).ok()?;
    let trimmed = token.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn fetch_imds_region(agent: &ureq::Agent, base: &str, token: &str) -> Option<String> {
    let url = format!("{base}/latest/meta-data/placement/region");
    let text = imds_get_text(agent, &url, token)?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn imds_get_text(agent: &ureq::Agent, url: &str, token: &str) -> Option<String> {
    let bytes = imds_get_bytes(agent, url, token)?;
    String::from_utf8(bytes).ok()
}

fn imds_get_bytes(agent: &ureq::Agent, url: &str, token: &str) -> Option<Vec<u8>> {
    let mut response = agent
        .get(url)
        .header("X-aws-ec2-metadata-token", token)
        .call()
        .ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    response
        .body_mut()
        .with_config()
        .limit(MAX_METADATA_BYTES)
        .read_to_vec()
        .ok()
}

fn probe_bucket_region(agent: &ureq::Agent, bucket: &str) -> Option<String> {
    let url = format!("https://{bucket}.s3.amazonaws.com/");
    let response = agent.head(&url).call().ok()?;
    let header = response.headers().get("x-amz-bucket-region")?;
    let region = header.to_str().ok()?.trim();
    if region.is_empty() {
        None
    } else {
        Some(region.to_owned())
    }
}

fn parse_metadata_credentials(bytes: &[u8]) -> Option<CachedCredentials> {
    let parsed: MetadataCredentialsResponse = serde_json::from_slice(bytes).ok()?;
    let access_key_id = parsed.access_key_id.trim();
    let secret_access_key = parsed.secret_access_key.trim();
    if access_key_id.is_empty() || secret_access_key.is_empty() {
        return None;
    }
    let session_token = parsed
        .token
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let expires_at = parsed
        .expiration
        .as_deref()
        .and_then(parse_iso8601_utc)
        .or_else(|| Some(SystemTime::now() + FALLBACK_CREDENTIAL_TTL));
    Some(CachedCredentials {
        creds: SigV4Credentials {
            access_key_id: access_key_id.to_owned(),
            secret_access_key: secret_access_key.to_owned(),
            session_token,
        },
        expires_at,
    })
}

fn is_still_fresh(expires_at: Option<SystemTime>, now: SystemTime) -> bool {
    match expires_at {
        None => true,
        Some(expiry) => expiry
            .checked_sub(CREDENTIAL_REFRESH_MARGIN)
            .is_some_and(|refresh_at| now < refresh_at),
    }
}

/// Parses RFC 3339 / ISO-8601 UTC timestamps of the form `YYYY-MM-DDTHH:MM:SSZ` (with optional
/// fractional seconds) returned by EC2 IMDS and ECS metadata services.
pub(crate) fn parse_iso8601_utc(input: &str) -> Option<SystemTime> {
    let trimmed = input.trim();
    let body = trimmed.strip_suffix('Z')?;
    let (date_part, time_with_frac) = body.split_once('T')?;
    let time_part = time_with_frac
        .split_once('.')
        .map_or(time_with_frac, |(main, _)| main);
    let mut date_iter = date_part.split('-');
    let year: i64 = date_iter.next()?.parse().ok()?;
    let month: u32 = date_iter.next()?.parse().ok()?;
    let day: u32 = date_iter.next()?.parse().ok()?;
    if date_iter.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut time_iter = time_part.split(':');
    let hour: u64 = time_iter.next()?.parse().ok()?;
    let minute: u64 = time_iter.next()?.parse().ok()?;
    let second: u64 = time_iter.next()?.parse().ok()?;
    if time_iter.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    let total_secs = u64::try_from(days)
        .ok()?
        .checked_mul(86_400)?
        .checked_add(hour * 3_600 + minute * 60 + second)?;
    UNIX_EPOCH.checked_add(Duration::from_secs(total_secs))
}
