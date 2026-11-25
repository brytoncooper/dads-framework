use dads_testing_dst::http_cache_mock::{HttpCacheMock, HttpFaultMode};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};

fn send_raw(addr: SocketAddr, req: &str) -> String {
    let Ok(mut s) = TcpStream::connect(addr) else {
        return String::new();
    };
    let _ = s.write_all(req.as_bytes());
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out
}

#[test]
fn put_get_head_and_fault_modes_work_cleanly() {
    let mock = HttpCacheMock::start(None).ok();
    assert!(mock.is_some());
    if let Some(mock) = mock {
        let put_resp = send_raw(
            mock.addr(),
            "PUT /cache/abcd.json HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 9\r\n\r\n{\"ok\":1}\n",
        );
        assert!(put_resp.starts_with("HTTP/1.1 200 OK"));
        let get_resp = send_raw(
            mock.addr(),
            "GET /cache/abcd.json HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        );
        assert!(get_resp.contains("{\"ok\":1}"));
        let head_resp = send_raw(
            mock.addr(),
            "HEAD /cache/abcd.json HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        );
        assert!(head_resp.starts_with("HTTP/1.1 200 OK"));
        mock.set_mode(HttpFaultMode::Return500);
        let err_resp = send_raw(
            mock.addr(),
            "GET /cache/abcd.json HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        );
        assert!(err_resp.starts_with("HTTP/1.1 500"));
        assert_eq!(mock.stats().puts, 1);
        assert_eq!(mock.stats().gets, 2);
        assert_eq!(mock.stats().heads, 1);
        assert_eq!(mock.stats().hits, 1);
    }
}
