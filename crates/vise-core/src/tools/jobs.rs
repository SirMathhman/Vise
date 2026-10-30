use super::types::ToolError;
use std::collections::BTreeMap;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// The most output one background task keeps. The oldest output is dropped first.
const MAX_OUTPUT: usize = 100 * 1024;

/// Windows flag: start a console program without creating a console window, so no window takes focus.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Background PowerShell commands, keyed by the id the model uses to refer to them.
#[derive(Default)]
pub struct Jobs {
    next_id: usize,
    running: BTreeMap<usize, Job>,
}

struct Job {
    child: Child,
    output: Arc<Mutex<Output>>,
    /// How many of the two pipe readers have reached the end of their pipe.
    readers_done: Arc<AtomicUsize>,
    /// The absolute output offset the model has read up to.
    cursor: u64,
}

#[derive(Default)]
struct Output {
    data: Vec<u8>,
    /// The absolute output offset of `data[0]`.
    start: u64,
}

impl Output {
    fn push(&mut self, bytes: &[u8]) {
        self.data.extend_from_slice(bytes);
        if self.data.len() > MAX_OUTPUT {
            let excess = self.data.len() - MAX_OUTPUT;
            self.data.drain(..excess);
            self.start += excess as u64;
        }
    }

    /// The output from `cursor` to the end, and the offset just past it. Output dropped since `cursor`
    /// is reported with a note.
    fn since(&self, cursor: u64) -> (String, u64) {
        let end = self.start + self.data.len() as u64;
        let mut text = String::new();
        if cursor < self.start {
            text.push_str("[earlier output was dropped]\n");
        }
        let skip = cursor.max(self.start) - self.start;
        text.push_str(&String::from_utf8_lossy(self.data.get(skip as usize..).unwrap_or_default()));
        (text, end)
    }
}

impl Jobs {
    /// Starts a command in `cwd`. Its output is collected from this point on, until the task is
    /// finished, killed, or dropped.
    pub fn start(&mut self, command: &str, cwd: &Path) -> Result<usize, ToolError> {
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", command])
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| ToolError::Failed(format!("cannot start powershell.exe: {err}")))?;

        let output = Arc::new(Mutex::new(Output::default()));
        let readers_done = Arc::new(AtomicUsize::new(0));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::Failed("cannot read the command's stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::Failed("cannot read the command's stderr".into()))?;
        spawn_reader(stdout, Arc::clone(&output), Arc::clone(&readers_done));
        spawn_reader(stderr, Arc::clone(&output), Arc::clone(&readers_done));

        self.next_id += 1;
        let id = self.next_id;
        self.running.insert(id, Job { child, output, readers_done, cursor: 0 });
        Ok(id)
    }

    /// Whether the task has exited. Does not wait.
    pub fn has_exited(&mut self, id: usize) -> Result<bool, ToolError> {
        let job = self.job(id)?;
        let status = job.child.try_wait().map_err(|err| ToolError::Failed(format!("cannot check task {id}: {err}")))?;
        Ok(status.is_some())
    }

    /// Removes a task that has exited, and returns its exit code and the output it has not yet returned.
    pub fn finish(&mut self, id: usize) -> Result<String, ToolError> {
        let mut job = self.take(id)?;
        let status = job.child.wait().map_err(|err| ToolError::Failed(format!("cannot wait for task {id}: {err}")))?;
        wait_for_readers(&job);
        let (text, _) = lock(&job.output).since(job.cursor);
        Ok(format!("{}\n{text}", exit_line(status)))
    }

    /// Returns the output since the last read, and whether the task is still running. A task that has
    /// finished is removed after its final output is returned.
    pub fn read(&mut self, id: usize) -> Result<String, ToolError> {
        let job = self.job(id)?;
        let status = job.child.try_wait().map_err(|err| ToolError::Failed(format!("cannot check task {id}: {err}")))?;
        if status.is_some() {
            wait_for_readers(job);
        }
        let (text, cursor) = lock(&job.output).since(job.cursor);
        job.cursor = cursor;
        match status {
            None => Ok(format!("task {id} is still running.\n{text}")),
            Some(status) => {
                self.running.remove(&id);
                Ok(format!("task {id} has finished. {}\n{text}", exit_line(status)))
            }
        }
    }

    /// Stops a task and every process it started, and returns the output it had not yet returned.
    pub fn kill(&mut self, id: usize) -> Result<String, ToolError> {
        let mut job = self.take(id)?;
        stop_tree(job.child.id());
        // Killing may fail if the task has just exited; either way it is no longer running.
        let _ = job.child.kill();
        let _ = job.child.wait();
        wait_for_readers(&job);
        let (text, _) = lock(&job.output).since(job.cursor);
        Ok(format!("stopped task {id}.\n{text}"))
    }

    /// Stops every running task. Used when the session ends.
    pub fn stop_all(&mut self) {
        let ids: Vec<usize> = self.running.keys().copied().collect();
        for id in ids {
            let _ = self.kill(id);
        }
    }

    fn job(&mut self, id: usize) -> Result<&mut Job, ToolError> {
        self.running.get_mut(&id).ok_or_else(|| no_task(id))
    }

    fn take(&mut self, id: usize) -> Result<Job, ToolError> {
        self.running.remove(&id).ok_or_else(|| no_task(id))
    }
}

fn no_task(id: usize) -> ToolError {
    ToolError::Failed(format!("there is no background task {id}"))
}

fn exit_line(status: ExitStatus) -> String {
    let code = status.code().map_or_else(|| "none".to_string(), |code| code.to_string());
    format!("exit code: {code}")
}

/// Stops a process and every process it started. This is the only platform-specific step: Windows'
/// `taskkill /T` walks the process tree. A failure is ignored, since the caller kills the shell process
/// directly as well.
fn stop_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

fn spawn_reader(mut pipe: impl Read + Send + 'static, output: Arc<Mutex<Output>>, done: Arc<AtomicUsize>) {
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut buf) {
            if n == 0 {
                break;
            }
            lock(&output).push(&buf[..n]);
        }
        done.fetch_add(1, Ordering::SeqCst);
    });
}

/// Waits briefly for both pipe readers to finish, so the output read next is complete. A grandchild
/// that still holds a pipe open cannot hold this up for more than two seconds.
fn wait_for_readers(job: &Job) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while job.readers_done.load(Ordering::SeqCst) < 2 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
}

fn lock(output: &Mutex<Output>) -> MutexGuard<'_, Output> {
    output.lock().unwrap_or_else(PoisonError::into_inner)
}
