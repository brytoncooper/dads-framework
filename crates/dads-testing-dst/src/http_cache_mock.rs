//! Zero-dependency in-process HTTP remote cache mock server for testing `remote_receipts.rs`.
//!
//! Binds an ephemeral `127.0.0.1:0` `TcpListener`, serves `GET`/`PUT`/`HEAD` receipt requests,
//! supports programmable fault injection, and shuts down cleanly on `Drop`.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpFaultMode {
    Healthy,
    CorruptBodyOnGet,
    TruncatedBodyOnGet,
    Return500,
    SlowTimeout,
    StaleReceiptPayload,
}

#[derive(Debug, Default, Clone)]
pub struct HttpMockStats {
    pub gets: usize,
    pub puts: usize,
    pub heads: usize,
    pub hits: usize,
}

struct MockState {
    blobs: BTreeMap<String, Vec<u8>>,
    mode: HttpFaultMode,
    required_bearer: Option<String>,
    stats: HttpMockStats,
}

pub struct HttpCacheMock {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<MockState>>,
    handle: Option<JoinHandle<()>>,
}

impl HttpCacheMock {
    pub fn start(required_bearer: Option<String>) -> Result<Self, String> {
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind http cache mock: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("local_addr http cache mock: {e}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(MockState {
            blobs: BTreeMap::new(),
            mode: HttpFaultMode::Healthy,
            required_bearer,
            stats: HttpMockStats::default(),
        }));
        let stop_bg = Arc::clone(&stop);
        let state_bg = Arc::clone(&state);
        let handle = thread::spawn(move || serve_loop(listener, stop_bg, state_bg));
        Ok(Self {
            addr,
            stop,
            state,
            handle: Some(handle),
        })
    }

    pub fn base_url(&self) -> String {
        format!("http://{}/cache", self.addr)
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn set_mode(&self, mode: HttpFaultMode) {
        if let Ok(mut guard) = self.state.lock() {
            guard.mode = mode;
        }
    }

    pub fn stats(&self) -> HttpMockStats {
        self.state
            .lock()
            .map(|guard| guard.stats.clone())
            .unwrap_or_default()
    }

    pub fn blob_count(&self) -> usize {
        self.state
            .lock()
            .map(|guard| guard.blobs.len())
            .unwrap_or(0)
    }
}

impl Drop for HttpCacheMock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn serve_loop(listener: TcpListener, stop: Arc<AtomicBool>, state: Arc<Mutex<MockState>>) {
    for incoming in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(mut stream) = incoming else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        handle_connection(&mut stream, &stop, &state);
    }
}

struct ParsedHttpRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

fn handle_connection(stream: &mut TcpStream, stop: &AtomicBool, state: &Mutex<MockState>) {
    let Some(req) = read_http_request(stream) else {
        return;
    };
    let (mode, required_bearer) = match state.lock() {
        Ok(guard) => (guard.mode, guard.required_bearer.clone()),
        Err(_) => return,
    };
    if let Some(expected) = required_bearer {
        let expected_hdr = format!("Bearer {expected}");
        if req.authorization.as_deref() != Some(expected_hdr.as_str()) {
            write_response(stream, "401 Unauthorized", b"unauthorized", false);
            return;
        }
    }
    match req.method.as_str() {
        "PUT" => handle_put(stream, state, mode, req.path, req.body),
        "HEAD" => handle_head(stream, state, mode, &req.path),
        "GET" => handle_get(stream, stop, state, mode, &req.path),
        _ => write_response(stream, "405 Method Not Allowed", b"", false),
    }
}

fn handle_put(
    stream: &mut TcpStream,
    state: &Mutex<MockState>,
    mode: HttpFaultMode,
    path: String,
    body: Vec<u8>,
) {
    if let Ok(mut guard) = state.lock() {
        guard.stats.puts += 1;
        if mode != HttpFaultMode::Return500 {
            guard.blobs.insert(path, body);
        }
    }
    if mode == HttpFaultMode::Return500 {
        write_response(stream, "500 Internal Server Error", b"injected 500", false);
    } else {
        write_response(stream, "200 OK", b"ok", false);
    }
}

fn handle_head(stream: &mut TcpStream, state: &Mutex<MockState>, mode: HttpFaultMode, path: &str) {
    let exists = match state.lock() {
        Ok(mut guard) => {
            guard.stats.heads += 1;
            guard.blobs.contains_key(path)
        }
        Err(_) => false,
    };
    if mode == HttpFaultMode::Return500 {
        write_response(stream, "500 Internal Server Error", b"", true);
    } else if exists {
        write_response(stream, "200 OK", b"", true);
    } else {
        write_response(stream, "404 Not Found", b"", true);
    }
}

fn handle_get(
    stream: &mut TcpStream,
    stop: &AtomicBool,
    state: &Mutex<MockState>,
    mode: HttpFaultMode,
    path: &str,
) {
    let blob = match state.lock() {
        Ok(mut guard) => {
            guard.stats.gets += 1;
            let found = guard.blobs.get(path).cloned();
            if found.is_some() && mode == HttpFaultMode::Healthy {
                guard.stats.hits += 1;
            }
            found
        }
        Err(_) => None,
    };
    match mode {
        HttpFaultMode::Healthy => match blob {
            Some(bytes) => write_response(stream, "200 OK", &bytes, false),
            None => write_response(stream, "404 Not Found", b"not found", false),
        },
        HttpFaultMode::CorruptBodyOnGet => {
            write_response(stream, "200 OK", b"{corrupt-remote-json", false);
        }
        HttpFaultMode::TruncatedBodyOnGet => {
            let partial = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n40\r\n{\"schemaVersion\":1";
            let _ = stream.write_all(partial);
        }
        HttpFaultMode::Return500 => {
            write_response(stream, "500 Internal Server Error", b"injected 500", false);
        }
        HttpFaultMode::SlowTimeout => {
            let start = Instant::now();
            while start.elapsed() < Duration::from_millis(3400) && !stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(50));
            }
            write_response(stream, "504 Gateway Timeout", b"timeout", false);
        }
        HttpFaultMode::StaleReceiptPayload => {
            let stale = br#"{"schemaVersion":1,"key":"0000deadbeef","passed":true,"stdout":null,"stderr":null}"#;
            write_response(stream, "200 OK", stale, false);
        }
    }
}

fn read_http_request(stream: &mut TcpStream) -> Option<ParsedHttpRequest> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
    };
    let header_str = std::str::from_utf8(&buf[..header_end]).ok()?;
    let mut lines = header_str.lines();
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?.to_owned();
    let path = request_line.next()?.to_owned();
    let mut content_length = 0usize;
    let mut authorization = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok().unwrap_or(0);
            } else if name.eq_ignore_ascii_case("authorization") {
                authorization = Some(value.trim().to_owned());
            }
        }
    }
    let body_start = header_end + 4;
    let mut body = buf[body_start..].to_vec();
    while body.len() < content_length && body.len() < 4 * 1024 * 1024 {
        let remaining = content_length - body.len();
        let to_read = remaining.min(chunk.len());
        let n = stream.read(&mut chunk[..to_read]).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length);
    Some(ParsedHttpRequest {
        method,
        path,
        authorization,
        body,
    })
}

fn write_response(stream: &mut TcpStream, status: &str, body: &[u8], head_only: bool) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    if !head_only && !body.is_empty() {
        let _ = stream.write_all(body);
    }
}
