//! A minimal HTTP/1.1 server that records raw requests and answers with per-test replies, plus helpers.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use archon_runtime::{
    ApiClientCore, BodyKind, ClientOptions, Method, OperationSpec, ParamSpec, ResponseKind, SecuritySchemeSpec,
};

/// A request as the server read it.
#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    /// The raw request-target (path and query, exactly as sent).
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("")
    }

    pub fn query(&self) -> &str {
        self.target.split_once('?').map_or("", |(_, q)| q)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub delay: Duration,
}

impl Reply {
    pub fn status(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: Vec::new(), delay: Duration::ZERO }
    }

    pub fn json(status: u16, body: &str) -> Self {
        Self::status(status).header("Content-Type", "application/json").body(body)
    }

    pub fn text(status: u16, body: &str) -> Self {
        Self::status(status).header("Content-Type", "text/plain").body(body)
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }

    pub fn delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

type Handler = Arc<dyn Fn(&Recorded) -> Reply + Send + Sync>;

pub struct TestServer {
    pub url: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl TestServer {
    pub fn start(handler: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Handler = Arc::new(handler);
        let recorded = requests.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let handler = handler.clone();
                let recorded = recorded.clone();
                thread::spawn(move || serve(stream, handler, recorded));
            }
        });
        Self { url, requests }
    }

    /// Replies with the same response to every request.
    pub fn replying(reply: Reply) -> Self {
        Self::start(move |_| reply.clone())
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    pub fn last(&self) -> Recorded {
        self.requests().pop().expect("no request received")
    }

    pub fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

fn serve(stream: TcpStream, handler: Handler, recorded: Arc<Mutex<Vec<Recorded>>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.trim_end().splitn(3, ' ');
    let method = parts.next().unwrap_or("").to_owned();
    let target = parts.next().unwrap_or("").to_owned();
    let mut headers = Vec::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
            break;
        }
        if let Some((name, value)) = header.trim_end().split_once(':') {
            headers.push((name.trim().to_owned(), value.trim().to_owned()));
        }
    }
    let find =
        |name: &str| headers.iter().find(|(n, _): &&(String, String)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
    let mut body = Vec::new();
    if let Some(length) = find("content-length") {
        body.resize(length.parse().unwrap_or(0), 0);
        reader.read_exact(&mut body).unwrap();
    } else if find("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).unwrap();
            let size = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
            let mut chunk = vec![0; size + 2];
            reader.read_exact(&mut chunk).unwrap();
            if size == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..size]);
        }
    }
    let request = Recorded { method, target, headers, body };
    recorded.lock().unwrap().push(request.clone());
    let reply = handler(&request);
    thread::sleep(reply.delay);

    let mut out = format!("HTTP/1.1 {} X\r\n", reply.status);
    for (name, value) in &reply.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", reply.body.len()));
    let mut stream = stream;
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.write_all(&reply.body);
    let _ = stream.flush();
}

/// A URL nothing listens on.
pub fn closed_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    url
}

pub fn core(base_url: &str) -> ApiClientCore {
    core_with(ClientOptions { base_url: base_url.to_owned(), ..ClientOptions::default() }, &[])
}

pub fn core_with(options: ClientOptions, schemes: &'static [(&'static str, SecuritySchemeSpec)]) -> ApiClientCore {
    ApiClientCore::new(options, schemes)
}

/// A GET operation without parameters answering JSON.
pub const fn get(path: &'static str) -> OperationSpec {
    op(Method::GET, path, &[], None, &[("200", ResponseKind::Json)])
}

/// An operation (`OperationSpec` holds a `Method`, which has a destructor, so statics cannot use `..get(…)`).
pub const fn op(
    method: Method,
    path: &'static str,
    params: &'static [ParamSpec],
    body: Option<(BodyKind, &'static str)>,
    responses: &'static [(&'static str, ResponseKind)],
) -> OperationSpec {
    OperationSpec {
        operation_name: "test",
        method,
        path,
        tags: &[],
        security: &[],
        params,
        body: match body {
            Some((kind, _)) => Some(kind),
            None => None,
        },
        body_media_type: match body {
            Some((_, media)) => Some(media),
            None => None,
        },
        responses,
    }
}
