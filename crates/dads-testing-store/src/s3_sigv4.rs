//! Pure-Rust AWS Signature Version 4 (SigV4) request signing for S3 `GET` and `PUT`.
//!
//! Keeps S3 receipt caching free of heavyweight SDK runtimes while matching AWS SigV4
//! canonicalization and HMAC-SHA256 key derivation byte-for-byte.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

pub(crate) const EMPTY_PAYLOAD_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SigV4Credentials {
    pub(crate) access_key_id: String,
    pub(crate) secret_access_key: String,
    pub(crate) session_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SignedS3Headers {
    pub(crate) host: String,
    pub(crate) amz_date: String,
    pub(crate) content_sha256: String,
    pub(crate) session_token: Option<String>,
    pub(crate) authorization: String,
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    encode_hex(&digest)
}

pub(crate) fn encode_s3_uri_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len() + 1);
    if !path.starts_with('/') {
        encoded.push('/');
    }
    for byte in path.bytes() {
        if byte == b'/' || is_unreserved(byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(upper_hex_nibble(byte >> 4));
            encoded.push(upper_hex_nibble(byte & 0x0f));
        }
    }
    encoded
}

pub(crate) struct S3SignRequest<'a> {
    pub(crate) method: &'a str,
    pub(crate) host: &'a str,
    pub(crate) canonical_uri: &'a str,
    pub(crate) region: &'a str,
    pub(crate) payload_sha256: &'a str,
}

pub(crate) fn sign_s3_request(
    request: &S3SignRequest<'_>,
    creds: &SigV4Credentials,
    now: SystemTime,
) -> Option<SignedS3Headers> {
    let (amz_date, date_stamp) = format_amz_timestamps(now)?;
    sign_s3_request_at(request, creds, &amz_date, &date_stamp)
}

pub(crate) fn sign_s3_request_at(
    request: &S3SignRequest<'_>,
    creds: &SigV4Credentials,
    amz_date: &str,
    date_stamp: &str,
) -> Option<SignedS3Headers> {
    let host = request.host;
    let payload_sha256 = request.payload_sha256;
    let (canonical_headers, signed_headers) = match creds.session_token.as_deref() {
        Some(token) => (
            format!(
                "host:{host}\nx-amz-content-sha256:{payload_sha256}\nx-amz-date:{amz_date}\nx-amz-security-token:{token}\n"
            ),
            "host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
        ),
        None => (
            format!("host:{host}\nx-amz-content-sha256:{payload_sha256}\nx-amz-date:{amz_date}\n"),
            "host;x-amz-content-sha256;x-amz-date",
        ),
    };
    let canonical_request = format!(
        "{}\n{}\n\n{canonical_headers}\n{signed_headers}\n{payload_sha256}",
        request.method, request.canonical_uri
    );
    let credential_scope = format!("{date_stamp}/{}/s3/aws4_request", request.region);
    let canonical_request_hash = sha256_hex(canonical_request.as_bytes());
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{canonical_request_hash}");

    let signing_key =
        derive_signing_key(&creds.secret_access_key, date_stamp, request.region, "s3")?;
    let signature = encode_hex(&hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        creds.access_key_id
    );

    Some(SignedS3Headers {
        host: host.to_owned(),
        amz_date: amz_date.to_owned(),
        content_sha256: payload_sha256.to_owned(),
        session_token: creds.session_token.clone(),
        authorization,
    })
}

pub(crate) fn derive_signing_key(
    secret_access_key: &str,
    date_stamp: &str,
    region: &str,
    service: &str,
) -> Option<Vec<u8>> {
    let initial_key = format!("AWS4{secret_access_key}");
    let k_date = hmac_sha256(initial_key.as_bytes(), date_stamp.as_bytes())?;
    let k_region = hmac_sha256(&k_date, region.as_bytes())?;
    let k_service = hmac_sha256(&k_region, service.as_bytes())?;
    hmac_sha256(&k_service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key).ok()?;
    mac.update(data);
    Some(mac.finalize().into_bytes().to_vec())
}

pub(crate) fn format_amz_timestamps(now: SystemTime) -> Option<(String, String)> {
    let secs = now.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let days = i64::try_from(secs / 86_400).ok()?;
    let rem = secs % 86_400;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;
    let (year, month, day) = civil_from_days(days);
    let date_stamp = format!("{year:04}{month:02}{day:02}");
    let amz_date = format!("{date_stamp}T{hour:02}{minute:02}{second:02}Z");
    Some((amz_date, date_stamp))
}

/// Converts days since 1970-01-01 to proleptic Gregorian `(year, month, day)`.
/// Uses Howard Hinnant's exact civil-from-days algorithm.
pub(crate) fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    (year, m as u32, d as u32)
}

/// Converts proleptic Gregorian `(year, month, day)` to days since 1970-01-01.
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = u64::from(month);
    let d = u64::from(day);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
}

fn upper_hex_nibble(nibble: u8) -> char {
    match nibble {
        0..=9 => char::from(b'0' + nibble),
        10..=15 => char::from(b'A' + (nibble - 10)),
        _ => '0',
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}
