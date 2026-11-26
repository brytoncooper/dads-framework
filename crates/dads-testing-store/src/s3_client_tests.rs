#![allow(clippy::unwrap_used, clippy::expect_used)]

use crate::receipts::FileReceiptStore;
use crate::remote_receipts::RemoteReceiptClient;
use crate::s3_client::NativeS3Client;
use crate::s3_sigv4::{S3SignRequest, SigV4Credentials, sha256_hex, sign_s3_request_at};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, RunResult,
    execute_request_with_graph_and_receipts,
};
use std::collections::HashMap;
use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const TEST_ACCESS_KEY: &str = "TESTACCESSKEY0000001";
const TEST_SECRET_KEY: &str = "test-secret-key-not-a-real-aws-credential";
const TEST_SESSION_TOKEN: &str = "test-session-token-value";
const TEST_REGION: &str = "us-west-2";

#[test]
fn native_s3_with_imdsv2_caches_credentials_verifies_sigv4_and_fails_closed()
-> Result<(), Box<dyn Error>> {
    let (imds_url, imds_token_calls) = start_mock_imdsv2_server()?;
    let (s3_url, blobs, s3_requests) = start_sigv4_verifying_s3_server()?;

    let dir = make_repo("native-s3-imdsv2", "printf 'native-ok'")?;
    let make_worker = |name: &str| {
        let client = NativeS3Client::for_test_endpoints(
            "command-ci-cache".to_owned(),
            "nx/task-results/v1/dad-test".to_owned(),
            s3_url.clone(),
            imds_url.clone(),
        );
        FileReceiptStore::in_directory(dir.join(format!(".git/{name}")))
            .with_remote_client(RemoteReceiptClient::S3(client))
    };

    // Worker 1 misses S3 (404), executes task, uploads via SigV4 PUT.
    let worker1 = make_worker("l1-w1");
    let r1 = run_task(&dir, &worker1)?;
    assert_eq!(r1.exit_code, 0);
    assert_eq!(r1.counts.cached, 0);
    assert_eq!(blobs.lock().unwrap().len(), 1);
    assert_eq!(imds_token_calls.load(Ordering::SeqCst), 1);

    // Worker 2 (fresh L1 dir) hits S3 (200) via SigV4 GET without re-executing!
    let worker2 = make_worker("l1-w2");
    let r2 = run_task(&dir, &worker2)?;
    assert_eq!(r2.exit_code, 0);
    assert_eq!(r2.counts.cached, 1);
    assert_eq!(imds_token_calls.load(Ordering::SeqCst), 2);
    assert!(s3_requests.load(Ordering::SeqCst) >= 3);

    // Corrupting the S3 object fails closed on Worker 3 (re-executes and overwrites cleanly).
    for blob in blobs.lock().unwrap().values_mut() {
        *blob = b"{corrupt-s3-blob".to_vec();
    }
    let worker3 = make_worker("l1-w3");
    let r3 = run_task(&dir, &worker3)?;
    assert_eq!(r3.exit_code, 0);
    assert_eq!(r3.counts.cached, 0);

    // Failing task never uploads to S3.
    let blobs_before_fail = blobs.lock().unwrap().len();
    write_manifest(&dir, "exit 1")?;
    let fail = run_task(&dir, &worker3)?;
    assert_eq!(fail.exit_code, 1);
    assert_eq!(fail.counts.cached, 0);
    assert_eq!(blobs.lock().unwrap().len(), blobs_before_fail);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

fn start_mock_imdsv2_server() -> Result<(String, Arc<AtomicUsize>), Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let token_calls = Arc::new(AtomicUsize::new(0));
    let calls_ref = Arc::clone(&token_calls);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let c = Arc::clone(&calls_ref);
            thread::spawn(move || handle_imds_connection(stream, &c));
        }
    });
    Ok((format!("http://{addr}"), token_calls))
}

fn handle_imds_connection(mut stream: TcpStream, token_calls: &AtomicUsize) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    while let Some(req) = read_http_request(&mut stream) {
        if req.method == "PUT" && req.path == "/latest/api/token" {
            token_calls.fetch_add(1, Ordering::SeqCst);
            write_http_response(&mut stream, 200, b"imds-v2-session-token");
            continue;
        }
        if req
            .headers
            .get("x-aws-ec2-metadata-token")
            .map(String::as_str)
            != Some("imds-v2-session-token")
        {
            write_http_response(&mut stream, 401, b"unauthorized");
            continue;
        }
        match req.path.as_str() {
            "/latest/meta-data/iam/security-credentials/" => {
                write_http_response(&mut stream, 200, b"ci-runner-role\n");
            }
            "/latest/meta-data/iam/security-credentials/ci-runner-role" => {
                let json = format!(
                    r#"{{"Code":"Success","AccessKeyId":"{TEST_ACCESS_KEY}","SecretAccessKey":"{TEST_SECRET_KEY}","Token":"{TEST_SESSION_TOKEN}","Expiration":"2099-01-01T00:00:00Z"}}"#
                );
                write_http_response(&mut stream, 200, json.as_bytes());
            }
            "/latest/meta-data/placement/region" => {
                write_http_response(&mut stream, 200, TEST_REGION.as_bytes());
            }
            _ => write_http_response(&mut stream, 404, b"not found"),
        }
    }
}

type SharedBlobs = Arc<Mutex<HashMap<String, Vec<u8>>>>;

fn start_sigv4_verifying_s3_server()
-> Result<(String, SharedBlobs, Arc<AtomicUsize>), Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let blobs: SharedBlobs = Arc::new(Mutex::new(HashMap::new()));
    let requests = Arc::new(AtomicUsize::new(0));
    let blobs_ref = Arc::clone(&blobs);
    let reqs_ref = Arc::clone(&requests);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let b = Arc::clone(&blobs_ref);
            let r = Arc::clone(&reqs_ref);
            thread::spawn(move || handle_s3_connection(stream, &b, &r));
        }
    });
    Ok((format!("http://{addr}"), blobs, requests))
}

fn handle_s3_connection(mut stream: TcpStream, blobs: &SharedBlobs, requests: &AtomicUsize) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    while let Some(req) = read_http_request(&mut stream) {
        requests.fetch_add(1, Ordering::SeqCst);
        if !verify_sigv4_request(&req.method, &req.path, &req.headers, &req.body) {
            write_http_response(&mut stream, 403, b"SignatureDoesNotMatch");
            continue;
        }
        match req.method.as_str() {
            "GET" => {
                let maybe = blobs
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&req.path).cloned());
                match maybe {
                    Some(data) => write_http_response(&mut stream, 200, &data),
                    None => write_http_response(
                        &mut stream,
                        404,
                        b"<Error><Code>NoSuchKey</Code></Error>",
                    ),
                }
            }
            "PUT" => {
                if let Ok(mut map) = blobs.lock() {
                    map.insert(req.path, req.body);
                }
                write_http_response(&mut stream, 200, b"");
            }
            _ => write_http_response(&mut stream, 405, b""),
        }
    }
}

fn verify_sigv4_request(
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
) -> bool {
    let Some(host) = headers.get("host") else {
        return false;
    };
    let Some(amz_date) = headers.get("x-amz-date") else {
        return false;
    };
    let Some(content_sha) = headers.get("x-amz-content-sha256") else {
        return false;
    };
    let Some(auth) = headers.get("authorization") else {
        return false;
    };
    let Some(token) = headers.get("x-amz-security-token") else {
        return false;
    };
    if token != TEST_SESSION_TOKEN || content_sha != &sha256_hex(body) || amz_date.len() < 8 {
        return false;
    }
    let creds = SigV4Credentials {
        access_key_id: TEST_ACCESS_KEY.to_owned(),
        secret_access_key: TEST_SECRET_KEY.to_owned(),
        session_token: Some(TEST_SESSION_TOKEN.to_owned()),
    };
    let req = S3SignRequest {
        method,
        host,
        canonical_uri: path,
        region: TEST_REGION,
        payload_sha256: content_sha,
    };
    let expected = sign_s3_request_at(&req, &creds, amz_date, &amz_date[..8]);
    expected.is_some_and(|signed| signed.authorization == *auth)
}

struct ParsedHttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> Option<ParsedHttpRequest> {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        raw.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&raw[..header_end]).into_owned();
    let mut lines = head.lines();
    let req_line = lines.next()?;
    let mut parts = req_line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    let content_len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    while raw.len() < header_end + content_len {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..n]);
    }
    let body = raw[header_end..raw.len().min(header_end + content_len)].to_vec();
    Some(ParsedHttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn write_http_response(stream: &mut TcpStream, status: u16, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn make_repo(label: &str, command: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("dads-native-s3-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("pkg"))?;
    assert!(
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()?
            .success()
    );
    fs::write(dir.join("pkg/index.ts"), "export const x = 1;\n")?;
    write_manifest(&dir, command)?;
    Ok(dir)
}

fn write_manifest(dir: &Path, command: &str) -> Result<(), Box<dyn Error>> {
    let manifest = format!(
        r#"{{
  "schemaVersion": 1,
  "workspace": {{ "root": ".", "fullFallback": {{ "taskIds": ["pkg:test"] }} }},
  "projects": [{{ "id": "pkg", "root": "pkg", "fallbackDependencies": [] }}],
  "tasks": [{{
    "id": "pkg:test",
    "project": "pkg",
    "kind": "test",
    "execution": {{ "executable": "sh", "args": ["-c", {cmd}], "cwd": "pkg" }},
    "dependsOn": [],
    "impact": {{ "mode": "project", "paths": ["pkg/index.ts"] }}
  }}]
}}"#,
        cmd = serde_json::to_string(command)?
    );
    fs::write(dir.join("dads.testing.json"), manifest)?;
    Ok(())
}

fn run_task(dir: &Path, store: &FileReceiptStore) -> Result<RunResult, Box<dyn Error>> {
    let response = execute_request_with_graph_and_receipts(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: dir.to_string_lossy().into_owned(),
            manifest_path: Some("dads.testing.json".to_owned()),
            only: true,
            task_ids: vec!["pkg:test".to_owned()],
            jobs: Some(1),
            cache: true,
            ..NativeRequest::default()
        },
        None,
        Some(store),
    );
    assert!(response.ok, "unexpected run failure: {:?}", response.error);
    response
        .result
        .and_then(|r| r.run)
        .ok_or_else(|| "missing run result".into())
}
