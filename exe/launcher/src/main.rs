// The Windows launcher for Vise. It writes the Vise server (embedded in this program) to the local app
// data folder, starts it on a free local port with a random token, and shows the page in a WebView2
// window. The server runs in the folder the launcher was started from. Closing the window ends the server.

mod job;

use std::fs;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use job::Job;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::{WebContext, WebViewBuilder};

// The Vise server, built by scripts/build-exe.ts before this program is built.
static SERVER: &[u8] = include_bytes!("../../../build/exe/vise-server.exe");

// How long the server has to start listening before the launcher gives up.
const START_TIMEOUT: Duration = Duration::from_secs(20);

// The event loop wakes with this when the server process ends on its own.
#[derive(Debug)]
enum UserEvent {
    ServerEnded,
}

fn main() {
    if let Err(message) = run() {
        eprintln!("vise: {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let data = data_dir();
    let server = write_server(&data)?;
    let port = free_port()?;
    let token = random_token();
    // The job ends the server when this program ends, including when it is force-killed. It is held by
    // show_window until the program exits, or dropped (ending the server) if the window cannot be shown.
    let job = Job::kill_on_close()?;
    let mut child = Command::new(&server)
        .arg("--web")
        .env("VISE_WEB_PORT", port.to_string())
        .env("VISE_WEB_TOKEN", &token)
        .stdin(Stdio::null())
        .spawn()
        .map_err(|error| format!("the server did not start: {error}"))?;
    job.assign(&child).inspect_err(|_| stop_server(child.id()))?;
    if let Err(message) = wait_until_listening(port, &mut child) {
        stop_server(child.id());
        return Err(message);
    }
    // The token is in the fragment, so it is not sent to the server in the request.
    let url = format!("http://127.0.0.1:{port}/#t={token}");
    show_window(&url, child, &data, job)
}

// The folder for the server and the WebView2 data: %LOCALAPPDATA%\Vise, or the temp folder without it.
fn data_dir() -> PathBuf {
    match std::env::var_os("LOCALAPPDATA") {
        Some(local) => PathBuf::from(local).join("Vise"),
        None => std::env::temp_dir().join("Vise"),
    }
}

// Writes the embedded server to the data folder, unless that file already holds exactly the embedded bytes.
// The bytes are compared, not just the size, so a planted or stale file is replaced before it runs. The name
// holds the version and size, so a build with different bytes does not overwrite the file of another build.
fn write_server(data: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(data).map_err(|error| format!("{} cannot be created: {error}", data.display()))?;
    let path = data.join(format!("vise-server-{}-{}.exe", env!("CARGO_PKG_VERSION"), SERVER.len()));
    let current = fs::read(&path).is_ok_and(|bytes| bytes == SERVER);
    if !current {
        let temp = data.join(format!("vise-server-{}.tmp", std::process::id()));
        fs::write(&temp, SERVER).map_err(|error| format!("the server cannot be written: {error}"))?;
        fs::rename(&temp, &path).map_err(|error| format!("the server cannot be written: {error}"))?;
    }
    Ok(path)
}

// A local port the OS has free right now. The server binds it when it starts.
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("no local port is free: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("no local port is free: {error}"))
}

// A token the page must send with each connection, so other programs on this machine cannot use the server.
fn random_token() -> String {
    (0..24).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
}

// Waits until the server accepts connections. Fails if it exits first or does not start in time.
fn wait_until_listening(port: u16, child: &mut Child) -> Result<(), String> {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let started = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("the server stopped before it started ({status})"));
        }
        if TcpStream::connect(address).is_ok() {
            return Ok(());
        }
        if started.elapsed() > START_TIMEOUT {
            return Err("the server did not start in time".to_string());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

// Ends the server and everything it started. Used when the window closes.
fn stop_server(pid: u32) {
    // taskkill /T ends the whole process tree, so the background jobs the server started end with it.
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

// Opens the window on the page and runs until it is closed or the server ends. The job is kept in the
// closure, so it lives as long as the program; if the window cannot be shown, dropping it ends the server.
fn show_window(url: &str, child: Child, data: &Path, job: Job) -> Result<(), String> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let pid = child.id();
    thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
        let _ = proxy.send_event(UserEvent::ServerEnded);
    });
    let window = WindowBuilder::new()
        .with_title("Vise")
        .with_inner_size(LogicalSize::new(1200.0, 800.0))
        .build(&event_loop)
        .map_err(|error| format!("the window cannot be opened: {error}"))?;
    let mut web_context = WebContext::new(Some(data.join("WebView2")));
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url(url)
        .build(&window)
        .map_err(|error| format!("the page cannot be shown (is the WebView2 runtime installed?): {error}"))?;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        // The window, the page, and the job are kept alive by this closure until the program exits.
        let _keep = (&window, &webview, &job);
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                stop_server(pid);
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::ServerEnded) => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}
