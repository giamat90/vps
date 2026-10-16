//! Hands a finished practice pack to the phone over the local network
//! (wiki/practice-pack.md, "Wi-Fi transfer").
//!
//! A short-lived HTTP server bound to one private address of this computer serves the pack at
//! `/pack/<token>`. The token is the secret and travels out of band, in the QR code the dialog
//! shows, so the link is useless to anyone who has not seen it. It is spent when the whole file has
//! gone out and the phone has closed the connection; an interrupted transfer can be retried.

use crate::commands::{build_pack_file, SidecarState, TempFile};
use crate::library;
use serde::Serialize;
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

pub const LIFETIME: Duration = Duration::from_secs(600);
pub const EVENT: &str = "pack-share";

const ROUTE_PREFIX: &str = "/pack/";
const REQUEST_LIMIT: usize = 8 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
const CHUNK: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 8;
const STALE_PACK_AGE: Duration = Duration::from_secs(24 * 3600);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShareEvent {
    Building { value: f32, stage: String },
    Sending { sent: u64, total: u64 },
    Interrupted,
    Done,
    Expired,
}

struct Inner {
    path: std::path::PathBuf,
    size: u64,
    file_name: String,
    token: String,
    stop: AtomicBool,
    spent: AtomicBool,
    sending: AtomicBool,
    connections: AtomicUsize,
    emit: Arc<dyn Fn(ShareEvent) + Send + Sync>,
}

impl Inner {
    /// A server that was stopped on purpose says nothing more: the caller already knows.
    fn notify(&self, event: ShareEvent) {
        if !self.stop.load(Ordering::SeqCst) {
            (self.emit)(event);
        }
    }
}

pub struct ShareServer {
    addr: SocketAddr,
    inner: Arc<Inner>,
    thread: Option<JoinHandle<()>>,
}

impl ShareServer {
    pub fn start(
        ip: Ipv4Addr,
        path: &Path,
        file_name: &str,
        lifetime: Duration,
        emit: impl Fn(ShareEvent) + Send + Sync + 'static,
    ) -> io::Result<ShareServer> {
        let size = std::fs::metadata(path)?.len();
        let listener = TcpListener::bind((ip, 0))?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        let inner = Arc::new(Inner {
            path: path.to_path_buf(),
            size,
            file_name: file_name.to_string(),
            token: uuid::Uuid::new_v4().simple().to_string(),
            stop: AtomicBool::new(false),
            spent: AtomicBool::new(false),
            sending: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            emit: Arc::new(emit),
        });
        let thread = std::thread::Builder::new().name("pack-share".into()).spawn({
            let inner = inner.clone();
            move || serve(listener, inner, Instant::now() + lifetime)
        })?;
        Ok(ShareServer { addr, inner, thread: Some(thread) })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn url(&self) -> String {
        format!("http://{}{}{}", self.addr, ROUTE_PREFIX, self.inner.token)
    }

    /// Stops listening, aborts a transfer in progress and waits (briefly) for it to let go of the file.
    pub fn stop(&mut self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                log::warn!("pack share thread panicked");
            }
        }
        let deadline = Instant::now() + DRAIN_TIMEOUT;
        while self.inner.connections.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for ShareServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn serve(listener: TcpListener, inner: Arc<Inner>, deadline: Instant) {
    loop {
        if inner.stop.load(Ordering::SeqCst) || inner.spent.load(Ordering::SeqCst) {
            return;
        }
        if Instant::now() >= deadline && !inner.sending.load(Ordering::SeqCst) {
            inner.notify(ShareEvent::Expired);
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if inner.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    inner.connections.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let inner = inner.clone();
                let spawned = std::thread::Builder::new().name("pack-share-conn".into()).spawn({
                    let inner = inner.clone();
                    move || {
                        handle(stream, &inner);
                        inner.connections.fetch_sub(1, Ordering::SeqCst);
                    }
                });
                if let Err(e) = spawned {
                    log::warn!("pack share: could not start a connection thread: {e}");
                    inner.connections.fetch_sub(1, Ordering::SeqCst);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => {
                log::warn!("pack share: accept failed: {e}");
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

enum HeadError {
    TooLarge,
    Gone,
}

fn read_head(stream: &mut TcpStream) -> Result<String, HeadError> {
    let mut data: Vec<u8> = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            return Ok(String::from_utf8_lossy(&data[..end]).into_owned());
        }
        if data.len() > REQUEST_LIMIT {
            return Err(HeadError::TooLarge);
        }
        match stream.read(&mut buf) {
            Ok(0) => return Err(HeadError::Gone),
            Ok(n) => data.extend_from_slice(&buf[..n]),
            Err(e) => {
                log::debug!("pack share: request not received: {e}");
                return Err(HeadError::Gone);
            }
        }
    }
}

fn respond(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &[u8]) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n",
        body.len()
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn reply(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)]) {
    if let Err(e) = respond(stream, status, headers, status.as_bytes()) {
        log::debug!("pack share: could not answer {status}: {e}");
    }
}

fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn handle(mut stream: TcpStream, inner: &Inner) {
    let setup = stream
        .set_nonblocking(false)
        .and_then(|_| stream.set_read_timeout(Some(REQUEST_TIMEOUT)))
        .and_then(|_| stream.set_write_timeout(Some(WRITE_TIMEOUT)));
    if let Err(e) = setup {
        log::debug!("pack share: connection setup failed: {e}");
        return;
    }
    let head = match read_head(&mut stream) {
        Ok(head) => head,
        Err(HeadError::TooLarge) => return reply(&mut stream, "431 Request Header Fields Too Large", &[]),
        Err(HeadError::Gone) => return,
    };
    let mut parts = head.lines().next().unwrap_or("").split(' ');
    let (method, target, version) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if !version.starts_with("HTTP/1.") || parts.next().is_some() {
        return reply(&mut stream, "400 Bad Request", &[]);
    }
    if method != "GET" && method != "HEAD" {
        return reply(&mut stream, "405 Method Not Allowed", &[("Allow", "GET, HEAD")]);
    }
    let path = target.split('?').next().unwrap_or("");
    let presented = path.strip_prefix(ROUTE_PREFIX).unwrap_or("");
    if !same_token(presented, &inner.token) || inner.spent.load(Ordering::SeqCst) {
        log::info!("pack share: refused a request for an unknown link");
        return reply(&mut stream, "404 Not Found", &[]);
    }
    let disposition = content_disposition(&inner.file_name);
    let size = inner.size.to_string();
    let headers = [
        ("Content-Type", "application/octet-stream"),
        ("Content-Disposition", disposition.as_str()),
    ];
    if method == "HEAD" {
        let mut head = format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\nCache-Control: no-store\r\n");
        for (name, value) in headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        if let Err(e) = stream.write_all(head.as_bytes()) {
            log::debug!("pack share: HEAD not delivered: {e}");
        }
        return;
    }
    if inner.sending.swap(true, Ordering::SeqCst) {
        return reply(&mut stream, "503 Service Unavailable", &[("Retry-After", "2")]);
    }
    let outcome = send_pack(&mut stream, inner, &headers, &size);
    inner.sending.store(false, Ordering::SeqCst);
    match outcome {
        Outcome::Completed => {
            inner.spent.store(true, Ordering::SeqCst);
            inner.notify(ShareEvent::Sending { sent: inner.size, total: inner.size });
            inner.notify(ShareEvent::Done);
        }
        Outcome::Failed => inner.notify(ShareEvent::Interrupted),
        Outcome::Stopped => {}
    }
}

enum Outcome {
    Completed,
    Failed,
    Stopped,
}

/// Completed means every byte was written and the phone then closed its end cleanly: bytes that
/// only reached this machine's send buffer do not count.
fn send_pack(stream: &mut TcpStream, inner: &Inner, headers: &[(&str, &str)], size: &str) -> Outcome {
    let mut file = match File::open(&inner.path) {
        Ok(file) => file,
        Err(e) => {
            log::warn!("pack share: the pack file cannot be opened: {e}");
            reply(stream, "500 Internal Server Error", &[]);
            return Outcome::Failed;
        }
    };
    let mut head = format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\nCache-Control: no-store\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    if let Err(e) = stream.write_all(head.as_bytes()) {
        log::debug!("pack share: headers not delivered: {e}");
        return Outcome::Failed;
    }
    inner.notify(ShareEvent::Sending { sent: 0, total: inner.size });

    let mut buf = vec![0u8; CHUNK];
    let mut sent = 0u64;
    let mut reported = Instant::now();
    loop {
        if inner.stop.load(Ordering::SeqCst) {
            return Outcome::Stopped;
        }
        let n = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                log::warn!("pack share: reading the pack failed: {e}");
                return Outcome::Failed;
            }
        };
        if let Err(e) = stream.write_all(&buf[..n]) {
            log::debug!("pack share: transfer interrupted after {sent} bytes: {e}");
            return Outcome::Failed;
        }
        sent += n as u64;
        if reported.elapsed() >= Duration::from_millis(150) {
            reported = Instant::now();
            inner.notify(ShareEvent::Sending { sent, total: inner.size });
        }
    }
    if let Err(e) = stream.flush().and_then(|_| stream.shutdown(Shutdown::Write)) {
        log::debug!("pack share: could not finish the response: {e}");
        return Outcome::Failed;
    }
    if let Err(e) = stream.set_read_timeout(Some(CLOSE_TIMEOUT)) {
        log::debug!("pack share: could not wait for the phone to close: {e}");
        return Outcome::Failed;
    }
    let mut sink = [0u8; 64];
    loop {
        match stream.read(&mut sink) {
            Ok(0) => return Outcome::Completed,
            Ok(_) => continue,
            Err(e) => {
                log::debug!("pack share: the phone did not close cleanly: {e}");
                return Outcome::Failed;
            }
        }
    }
}

/// `attachment` with an ASCII fallback and the real name as RFC 5987 `filename*`, so a browser that
/// ends up on the link (a camera app instead of the scanner) saves a proper `.vppack`.
fn content_disposition(file_name: &str) -> String {
    let ascii: String = file_name
        .chars()
        .map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '_' })
        .map(|c| if matches!(c, '"' | '\\' | '/' | ':' | '*' | '?' | '<' | '>' | '|' | ';' | '%') { '_' } else { c })
        .collect();
    let mut encoded = String::new();
    for b in file_name.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanAddress {
    pub ip: String,
    pub name: String,
    pub virtual_adapter: bool,
}

fn looks_virtual(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        "vethernet", "wsl", "hyper-v", "virtualbox", "vbox", "vmware", "vmnet", "docker", "podman", "tailscale",
        "zerotier", "hamachi", "wireguard", "openvpn", "vpn", "tap-", "tun", "npcap", "loopback", "bluetooth",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Private IPv4 addresses worth offering, best first: the one this computer would use to reach the
/// internet, then real adapters, then virtual ones. Loopback, link-local and public addresses never
/// make the list.
pub fn rank_addresses(found: Vec<(String, Ipv4Addr)>, route: Option<Ipv4Addr>) -> Vec<LanAddress> {
    let mut seen: Vec<Ipv4Addr> = Vec::new();
    let mut out: Vec<(bool, LanAddress)> = Vec::new();
    for (name, ip) in found {
        if !ip.is_private() || seen.contains(&ip) {
            continue;
        }
        seen.push(ip);
        let virtual_adapter = looks_virtual(&name);
        out.push((Some(ip) == route, LanAddress { ip: ip.to_string(), name, virtual_adapter }));
    }
    out.sort_by_key(|(on_route, a)| (!*on_route, a.virtual_adapter));
    out.into_iter().map(|(_, a)| a).collect()
}

/// The address the OS would put on a packet to the internet. Connecting a UDP socket only picks a
/// route; nothing is sent.
fn route_address() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    ["8.8.8.8:80", "192.168.0.1:80", "10.0.0.1:80", "172.16.0.1:80"].iter().find_map(|target| {
        socket.connect(target).ok()?;
        match socket.local_addr().ok()?.ip() {
            std::net::IpAddr::V4(ip) if !ip.is_unspecified() => Some(ip),
            _ => None,
        }
    })
}

pub fn lan_addresses() -> Result<Vec<LanAddress>, String> {
    let interfaces = if_addrs::get_if_addrs().map_err(|e| format!("Could not list the network adapters: {e}"))?;
    let found = interfaces
        .into_iter()
        .filter(|i| i.is_oper_up() && !i.is_loopback())
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(ip) => Some((i.name, ip)),
            _ => None,
        })
        .collect();
    Ok(rank_addresses(found, route_address()))
}

#[derive(Default)]
struct Slot {
    pack: Option<PreparedPack>,
    server: Option<ShareServer>,
}

struct PreparedPack {
    song_id: String,
    file_name: String,
    summary: serde_json::Value,
    temp: TempFile,
}

/// What the dialog has open: the pack built for one song and, while the dialog shows its code, the
/// server handing it out. Changing the network reuses the pack; closing the dialog drops both.
#[derive(Default)]
pub struct ShareState {
    slot: Mutex<Slot>,
    generation: AtomicU64,
}

pub struct Started {
    pub url: String,
    pub addr: SocketAddr,
    pub summary: serde_json::Value,
}

impl ShareState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Slot>, String> {
        self.slot.lock().map_err(|e| format!("lock: {e}"))
    }

    pub fn start(
        &self,
        sidecar: &SidecarState,
        song_id: &str,
        ip: Ipv4Addr,
        lifetime: Duration,
        emit: impl Fn(ShareEvent) + Send + Sync + 'static,
    ) -> Result<Started, String> {
        let emit: Arc<dyn Fn(ShareEvent) + Send + Sync> = Arc::new(emit);
        let serve_emit = emit.clone();
        self.start_with(song_id, ip, lifetime, move |e| serve_emit(e), || {
            sweep_stale_packs();
            let song = library::load_songs()?
                .into_iter()
                .find(|s| s.id == song_id)
                .ok_or_else(|| "Song not found".to_string())?;
            let built = build_pack_file(sidecar, &song, &mut |value, stage| {
                emit(ShareEvent::Building { value, stage: stage.to_string() })
            })?;
            Ok(PreparedPack {
                song_id: song_id.to_string(),
                file_name: format!("{}.vppack", song.title),
                summary: built.summary,
                temp: built.temp,
            })
        })
    }

    /// `build` runs only when the pack for `song_id` is not already built. It takes seconds, during
    /// which `stop` may be called: the generation tells the finished build that nobody wants it.
    fn start_with(
        &self,
        song_id: &str,
        ip: Ipv4Addr,
        lifetime: Duration,
        emit: impl Fn(ShareEvent) + Send + Sync + 'static,
        build: impl FnOnce() -> Result<PreparedPack, String>,
    ) -> Result<Started, String> {
        let generation = self.generation.load(Ordering::SeqCst);
        let reuse = {
            let mut slot = self.lock()?;
            if let Some(mut old) = slot.server.take() {
                old.stop();
            }
            slot.pack.as_ref().is_some_and(|p| p.song_id == song_id && p.temp.path().is_file())
        };
        if !reuse {
            let prepared = build()?;
            let mut slot = self.lock()?;
            if self.generation.load(Ordering::SeqCst) != generation {
                return Err("Cancelled.".to_string());
            }
            slot.pack = Some(prepared);
        }
        let mut slot = self.lock()?;
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err("Cancelled.".to_string());
        }
        let pack = slot.pack.as_ref().ok_or("The pack is gone.")?;
        let server = ShareServer::start(ip, pack.temp.path(), &pack.file_name, lifetime, emit)
            .map_err(|e| format!("Could not open a port on {ip}: {e}"))?;
        let started = Started { url: server.url(), addr: server.addr(), summary: pack.summary.clone() };
        log::info!("pack share listening on {}", server.addr());
        slot.server = Some(server);
        Ok(started)
    }

    pub fn stop(&self) -> Result<(), String> {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let (server, pack) = {
            let mut slot = self.lock()?;
            (slot.server.take(), slot.pack.take())
        };
        drop(server);
        drop(pack);
        Ok(())
    }
}

/// A pack left behind by a crash or a forced exit; anything younger may belong to a running export.
fn sweep_stale_packs() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("vps-pack-") && name.ends_with(".vppack")) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > STALE_PACK_AGE);
        if stale {
            if let Err(e) = std::fs::remove_file(entry.path()) {
                log::warn!("could not remove a stale pack {name}: {e}");
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub url: String,
    pub ip: String,
    pub port: u16,
    pub expires_in_s: u64,
    pub summary: serde_json::Value,
    pub addresses: Vec<LanAddress>,
}

/// Builds the pack of a song and starts handing it out on this computer's local network.
/// `address` is one of the addresses offered by an earlier call; none picks the best.
#[tauri::command]
pub async fn start_pack_share(
    app: AppHandle,
    sidecar: State<'_, SidecarState>,
    share: State<'_, ShareState>,
    song_id: String,
    address: Option<String>,
) -> Result<ShareInfo, String> {
    let addresses = lan_addresses()?;
    let chosen = match &address {
        Some(wanted) => addresses.iter().find(|a| &a.ip == wanted),
        None => addresses.first(),
    }
    .ok_or_else(|| match address {
        Some(_) => "That network address is no longer available.".to_string(),
        None => "No local network found. Connect this computer to Wi-Fi or Ethernet.".to_string(),
    })?;
    let ip: Ipv4Addr = chosen.ip.parse().map_err(|e| format!("Bad address {}: {e}", chosen.ip))?;
    let started = share.start(&sidecar, &song_id, ip, LIFETIME, move |event| {
        if let Err(e) = app.emit(EVENT, &event) {
            log::warn!("could not send the {EVENT} event: {e}");
        }
    })?;
    Ok(ShareInfo {
        url: started.url,
        ip: started.addr.ip().to_string(),
        port: started.addr.port(),
        expires_in_s: LIFETIME.as_secs(),
        summary: started.summary,
        addresses,
    })
}

/// Closes the server and forgets the pack. Safe to call when nothing is shared.
#[tauri::command]
pub fn stop_pack_share(share: State<'_, ShareState>) -> Result<(), String> {
    share.stop()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver};

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    struct Fixture {
        _dir: tempdir::Dir,
        path: std::path::PathBuf,
        bytes: Vec<u8>,
    }

    mod tempdir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Dir {
                let p = std::env::temp_dir().join(format!("vps-share-test-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn fixture(len: usize) -> Fixture {
        let dir = tempdir::Dir::new();
        let path = dir.0.join("pack.vppack");
        let bytes: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        Fixture { _dir: dir, path, bytes }
    }

    fn start(f: &Fixture, lifetime: Duration) -> (ShareServer, Receiver<ShareEvent>) {
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        let server = ShareServer::start(ip("127.0.0.1"), &f.path, "Seven Nation Army.vppack", lifetime, move |e| {
            let _ = tx.lock().unwrap().send(e);
        })
        .unwrap();
        (server, rx)
    }

    struct Reply {
        status: String,
        headers: String,
        body: Vec<u8>,
    }

    fn get(server: &ShareServer, method: &str, path: &str) -> Reply {
        let mut s = TcpStream::connect(server.addr()).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        write!(s, "{method} {path} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut raw = Vec::new();
        s.read_to_end(&mut raw).unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("no header end");
        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let (status, headers) = head.split_once("\r\n").unwrap_or((&head, ""));
        Reply { status: status.to_string(), headers: headers.to_string(), body: raw[split + 4..].to_vec() }
    }

    fn token_path(server: &ShareServer) -> String {
        server.url().split_once(&server.addr().to_string()).unwrap().1.to_string()
    }

    fn events_until(rx: &Receiver<ShareEvent>, last: ShareEvent) -> Vec<ShareEvent> {
        let mut seen = Vec::new();
        loop {
            let e = rx.recv_timeout(Duration::from_secs(10)).unwrap_or_else(|_| panic!("no {last:?}; saw {seen:?}"));
            seen.push(e.clone());
            if e == last {
                return seen;
            }
        }
    }

    fn port_is_closed(addr: SocketAddr) -> bool {
        for _ in 0..50 {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn the_pack_is_served_whole_with_a_download_name_and_then_the_door_closes() {
        let f = fixture(300_000);
        let (server, rx) = start(&f, Duration::from_secs(30));
        let reply = get(&server, "GET", &token_path(&server));
        assert_eq!(reply.status, "HTTP/1.1 200 OK");
        assert_eq!(reply.body, f.bytes);
        assert!(reply.headers.contains("Content-Length: 300000"));
        assert!(reply.headers.contains("Content-Disposition: attachment; filename=\"Seven Nation Army.vppack\""));
        let events = events_until(&rx, ShareEvent::Done);
        assert_eq!(events.first(), Some(&ShareEvent::Sending { sent: 0, total: 300_000 }));
        assert!(events.contains(&ShareEvent::Sending { sent: 300_000, total: 300_000 }));
        assert!(port_is_closed(server.addr()), "a spent link must not keep a port open");
    }

    #[test]
    fn anything_but_the_exact_link_gets_a_404_and_the_link_still_works_afterwards() {
        let f = fixture(1000);
        let (server, _rx) = start(&f, Duration::from_secs(30));
        let good = token_path(&server);
        let wrong = format!("{ROUTE_PREFIX}{}", "0".repeat(32));
        for path in ["/", "/pack", "/pack/", &wrong, &format!("{good}0"), &good[..good.len() - 1], "/favicon.ico", "/../pack"] {
            let reply = get(&server, "GET", path);
            assert_eq!(reply.status, "HTTP/1.1 404 Not Found", "{path}");
            assert_eq!(reply.body, b"404 Not Found", "{path} must not reveal anything");
        }
        assert_eq!(get(&server, "POST", &good).status, "HTTP/1.1 405 Method Not Allowed");
        assert_eq!(get(&server, "GET", &good).status, "HTTP/1.1 200 OK");
    }

    #[test]
    fn a_head_request_describes_the_pack_without_spending_the_link() {
        let f = fixture(5000);
        let (server, _rx) = start(&f, Duration::from_secs(30));
        let path = token_path(&server);
        let head = get(&server, "HEAD", &path);
        assert_eq!(head.status, "HTTP/1.1 200 OK");
        assert!(head.headers.contains("Content-Length: 5000"));
        assert!(head.body.is_empty());
        assert_eq!(get(&server, "GET", &path).body, f.bytes);
    }

    #[test]
    fn malformed_and_oversized_requests_are_refused_without_taking_the_server_down() {
        let f = fixture(1000);
        let (server, _rx) = start(&f, Duration::from_secs(30));
        for raw in ["garbage\r\n\r\n".to_string(), "GET /x HTTP/1.1 extra\r\n\r\n".to_string(), "GET / SPDY/3\r\n\r\n".to_string()] {
            let mut s = TcpStream::connect(server.addr()).unwrap();
            s.write_all(raw.as_bytes()).unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            assert!(out.starts_with("HTTP/1.1 400"), "{raw:?} -> {out:?}");
        }
        let mut s = TcpStream::connect(server.addr()).unwrap();
        s.write_all(format!("GET /{} HTTP/1.1\r\n", "a".repeat(20_000)).as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 431") || out.is_empty());
        assert_eq!(get(&server, "GET", &token_path(&server)).status, "HTTP/1.1 200 OK");
    }

    #[test]
    fn a_transfer_the_phone_walks_away_from_does_not_spend_the_link() {
        let f = fixture(24 * 1024 * 1024);
        let (server, rx) = start(&f, Duration::from_secs(60));
        let path = token_path(&server);
        {
            let mut s = TcpStream::connect(server.addr()).unwrap();
            write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            let mut some = [0u8; 4096];
            s.read_exact(&mut some).unwrap();
        }
        let events = events_until(&rx, ShareEvent::Interrupted);
        assert!(!events.contains(&ShareEvent::Done));
        let reply = get(&server, "GET", &path);
        assert_eq!(reply.body.len(), f.bytes.len());
        assert!(reply.body == f.bytes);
        events_until(&rx, ShareEvent::Done);
    }

    #[test]
    fn a_second_download_during_the_first_is_told_to_wait() {
        let f = fixture(24 * 1024 * 1024);
        let (server, _rx) = start(&f, Duration::from_secs(60));
        let path = token_path(&server);
        let mut slow = TcpStream::connect(server.addr()).unwrap();
        write!(slow, "GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut some = [0u8; 4096];
        slow.read_exact(&mut some).unwrap();
        let busy = get(&server, "GET", &path);
        assert_eq!(busy.status, "HTTP/1.1 503 Service Unavailable");
        assert!(busy.headers.contains("Retry-After: 2"));
    }

    #[test]
    fn stopping_closes_the_port_and_cuts_a_running_transfer_without_reporting_it() {
        let f = fixture(24 * 1024 * 1024);
        let (mut server, rx) = start(&f, Duration::from_secs(60));
        let path = token_path(&server);
        let addr = server.addr();
        let mut slow = TcpStream::connect(addr).unwrap();
        write!(slow, "GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut some = [0u8; 4096];
        slow.read_exact(&mut some).unwrap();
        server.stop();
        assert!(port_is_closed(addr));
        while let Ok(e) = rx.try_recv() {
            assert!(matches!(e, ShareEvent::Sending { .. }), "a stopped server says nothing more, got {e:?}");
        }
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn the_link_expires() {
        let f = fixture(1000);
        let (server, rx) = start(&f, Duration::from_millis(300));
        events_until(&rx, ShareEvent::Expired);
        assert!(port_is_closed(server.addr()));
    }

    #[test]
    fn changing_the_network_reuses_the_built_pack_and_closing_forgets_it() {
        let f = fixture(2000);
        let path = f.path.clone();
        let state = ShareState::default();
        state.lock().unwrap().pack = Some(PreparedPack {
            song_id: "s1".into(),
            file_name: "Song.vppack".into(),
            summary: serde_json::json!({"sizeBytes": 2000}),
            temp: TempFile::new(path.clone()),
        });
        let nobody = SidecarState(Mutex::new(None));
        let first = state.start(&nobody, "s1", ip("127.0.0.1"), Duration::from_secs(30), |_| {}).expect("first start");
        let second = state.start(&nobody, "s1", ip("127.0.0.1"), Duration::from_secs(30), |_| {}).expect("second start");
        assert_ne!(first.url, second.url, "a new code each time");
        assert!(TcpStream::connect_timeout(&first.addr, Duration::from_millis(300)).is_err(), "the first server is gone");
        assert_eq!(second.summary["sizeBytes"], 2000);
        let mut s = TcpStream::connect(second.addr).unwrap();
        let target = second.url.split_once(&second.addr.to_string()).unwrap().1.to_string();
        write!(s, "GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut raw = Vec::new();
        s.read_to_end(&mut raw).unwrap();
        assert!(raw.ends_with(&f.bytes));

        state.stop().unwrap();
        assert!(port_is_closed(second.addr));
        assert!(!path.exists(), "closing the dialog removes the pack from the temp folder");
        assert!(state.lock().unwrap().pack.is_none());
    }

    #[test]
    fn a_start_that_was_cancelled_while_the_pack_was_building_opens_nothing() {
        let f = fixture(500);
        let state = Arc::new(ShareState::default());
        let path = f.path.clone();
        let during_build = state.clone();
        let result = state.start_with("s1", ip("127.0.0.1"), Duration::from_secs(30), |_| {}, move || {
            during_build.stop().unwrap();
            Ok(PreparedPack {
                song_id: "s1".into(),
                file_name: "Song.vppack".into(),
                summary: serde_json::json!({}),
                temp: TempFile::new(path),
            })
        });
        assert_eq!(result.err().as_deref(), Some("Cancelled."));
        assert!(state.lock().unwrap().server.is_none(), "no server may be left running for a closed dialog");
        assert!(state.lock().unwrap().pack.is_none());
    }

    #[test]
    fn a_failed_build_leaves_nothing_running_and_is_reported() {
        let state = ShareState::default();
        let result = state.start_with("s1", ip("127.0.0.1"), Duration::from_secs(30), |_| {}, || Err("ffmpeg is missing".to_string()));
        assert_eq!(result.err().as_deref(), Some("ffmpeg is missing"));
        assert!(state.lock().unwrap().server.is_none());
    }

    #[test]
    fn every_share_gets_its_own_unguessable_token() {
        let f = fixture(10);
        let (a, _) = start(&f, Duration::from_secs(5));
        let (b, _) = start(&f, Duration::from_secs(5));
        let ta = token_path(&a);
        let tb = token_path(&b);
        assert_ne!(ta, tb);
        let token = ta.strip_prefix(ROUTE_PREFIX).unwrap();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn the_download_name_survives_quotes_unicode_and_path_characters() {
        assert_eq!(
            content_disposition("Seven Nation Army.vppack"),
            "attachment; filename=\"Seven Nation Army.vppack\"; filename*=UTF-8''Seven%20Nation%20Army.vppack"
        );
        let nasty = content_disposition("A\"b/c\\d\r\nCafé ☕.vppack");
        assert!(!nasty.contains('\r') && !nasty.contains('\n'));
        assert!(nasty.starts_with("attachment; filename=\"A_b_c_d__Caf_ _.vppack\"; filename*=UTF-8''A%22b%2Fc%5Cd%0D%0ACaf%C3%A9%20%E2%98%95.vppack"), "{nasty}");
    }

    #[test]
    fn addresses_are_private_only_and_ranked_route_first_then_real_adapters_then_virtual() {
        let found = vec![
            ("vEthernet (WSL)".to_string(), ip("172.24.16.1")),
            ("Loopback".to_string(), ip("127.0.0.1")),
            ("Ethernet".to_string(), ip("10.0.0.5")),
            ("Wi-Fi".to_string(), ip("192.168.1.20")),
            ("Tailscale".to_string(), ip("100.101.102.103")),
            ("Wi-Fi 2".to_string(), ip("169.254.9.9")),
            ("Public".to_string(), ip("93.184.216.34")),
            ("Wi-Fi again".to_string(), ip("192.168.1.20")),
        ];
        let ranked = rank_addresses(found.clone(), Some(ip("192.168.1.20")));
        let order: Vec<_> = ranked.iter().map(|a| a.ip.as_str()).collect();
        assert_eq!(order, ["192.168.1.20", "10.0.0.5", "172.24.16.1"]);
        assert!(ranked[2].virtual_adapter && !ranked[0].virtual_adapter);

        let no_route = rank_addresses(found.clone(), None);
        assert_eq!(no_route.iter().map(|a| a.ip.as_str()).collect::<Vec<_>>(), ["10.0.0.5", "192.168.1.20", "172.24.16.1"]);

        let vpn_route = rank_addresses(found, Some(ip("172.24.16.1")));
        assert_eq!(vpn_route[0].ip, "172.24.16.1", "what the OS routes through comes first even when it looks virtual; the dialog lets the user switch");
    }

    #[test]
    fn this_computers_adapters_can_be_listed() {
        let addresses = lan_addresses().expect("adapters");
        for a in &addresses {
            assert!(a.ip.parse::<Ipv4Addr>().unwrap().is_private(), "{a:?}");
        }
        eprintln!("adapters on this machine: {addresses:?}");
    }
}
