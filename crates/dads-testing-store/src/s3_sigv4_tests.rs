#![allow(clippy::unwrap_used, clippy::expect_used)]

use crate::s3_client::build_s3_target;
use crate::s3_credentials::parse_iso8601_utc;
use crate::s3_sigv4::{
    EMPTY_PAYLOAD_SHA256, S3SignRequest, SigV4Credentials, derive_signing_key, encode_s3_uri_path,
    format_amz_timestamps, sha256_hex, sign_s3_request_at,
};
use std::time::UNIX_EPOCH;

const TEST_ACCESS_KEY: &str = "TESTACCESSKEY0000001";
const TEST_SECRET_KEY: &str = "test-secret-key-not-a-real-aws-credential";

#[test]
fn sigv4_matches_aws_spec_key_derivation_and_s3_get_put_vectors() {
    let key = derive_signing_key(TEST_SECRET_KEY, "20130524", "us-east-1", "s3").unwrap();
    let key_hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        key_hex,
        "e4bd49b9d716a04cdf4e770df09c640b5771358016d5486071691693059962ac"
    );

    let creds_no_token = SigV4Credentials {
        access_key_id: TEST_ACCESS_KEY.to_owned(),
        secret_access_key: TEST_SECRET_KEY.to_owned(),
        session_token: None,
    };
    let get_req = S3SignRequest {
        method: "GET",
        host: "examplebucket.s3.us-east-1.amazonaws.com",
        canonical_uri: "/prefix/abcd.json",
        region: "us-east-1",
        payload_sha256: EMPTY_PAYLOAD_SHA256,
    };
    let get_signed =
        sign_s3_request_at(&get_req, &creds_no_token, "20130524T000000Z", "20130524").unwrap();
    assert_eq!(
        get_signed.authorization,
        "AWS4-HMAC-SHA256 Credential=TESTACCESSKEY0000001/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=98edc415f9c640262ad754af0fff0d2f10dc394296566759b08942affd55f3ad"
    );

    let creds_with_token = SigV4Credentials {
        access_key_id: TEST_ACCESS_KEY.to_owned(),
        secret_access_key: TEST_SECRET_KEY.to_owned(),
        session_token: Some("test-session-token-value".to_owned()),
    };
    let body_hash = sha256_hex(br#"{"ok":true}"#);
    let put_req = S3SignRequest {
        method: "PUT",
        host: "examplebucket.s3.us-west-2.amazonaws.com",
        canonical_uri: "/nx/task-results/v1/dad-test/deadbeef.json",
        region: "us-west-2",
        payload_sha256: &body_hash,
    };
    let put_signed =
        sign_s3_request_at(&put_req, &creds_with_token, "20261125T200000Z", "20261125").unwrap();
    let expected_put_sig = "3461fc917ca031fac40a9edf181ba69c53d759e1773278ca5c67f33c04fac815";
    let expected_put_header = format!(
        "AWS4-HMAC-SHA256 Credential=TESTACCESSKEY0000001/20261125/us-west-2/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature={expected_put_sig}"
    );
    assert_eq!(put_signed.authorization, expected_put_header);
}

#[test]
fn uri_encoding_and_utc_timestamp_roundtrip_work_across_leap_dates() {
    assert_eq!(
        encode_s3_uri_path("nx/task-results/v1/a b+c~d.json"),
        "/nx/task-results/v1/a%20b%2Bc~d.json"
    );
    let target = build_s3_target("my-bucket", "prefix/key.json", "us-west-2", None).unwrap();
    assert_eq!(
        target.url,
        "https://my-bucket.s3.us-west-2.amazonaws.com/prefix/key.json"
    );
    let custom = build_s3_target(
        "my-bucket",
        "prefix/key.json",
        "us-west-2",
        Some("http://127.0.0.1:9000"),
    )
    .unwrap();
    assert_eq!(
        custom.url,
        "http://127.0.0.1:9000/my-bucket/prefix/key.json"
    );
    assert_eq!(custom.host, "127.0.0.1:9000");

    for ts in [
        "2024-02-29T23:59:59Z",
        "2026-11-25T20:15:30Z",
        "2026-11-25T20:15:30.123Z",
    ] {
        let parsed = parse_iso8601_utc(ts).unwrap();
        let (amz_date, date_stamp) = format_amz_timestamps(parsed).unwrap();
        let expected_date = ts[..10].replace('-', "");
        let expected_time = ts[11..19].replace(':', "");
        assert_eq!(date_stamp, expected_date);
        assert_eq!(amz_date, format!("{expected_date}T{expected_time}Z"));
    }
    assert!(parse_iso8601_utc("not-a-date").is_none());
    assert!(format_amz_timestamps(UNIX_EPOCH).is_some());
}
