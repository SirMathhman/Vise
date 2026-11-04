import { err, ok, type Result } from "../core/result.ts";
import { MAX_LINES } from "../core/tools.ts";

export const MAX_JOBS = 5;
// A line longer than this is cut, so one line cannot grow memory without limit.
const MAX_LINE_CHARS = 8192;
// How many times session end tries to stop a job whose stop failed.
const STOP_ATTEMPTS = 3;

type Process = Bun.Subprocess<"ignore", "pipe", "pipe">;
// Stops a process tree and reports whether it succeeded.
export type StopTree = (pid: number) => Promise<boolean>;

// A job that could not be stopped, reported when the session ends.
export interface UnstoppedJob {
  id: number;
  pid: number;
  command: string;
}

// A line longer than MAX_LINE_CHARS is cut and marked.
function capLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [line cut]` : line;
}

// The last MAX_LINES lines of one output stream. Older lines are dropped and the text says so.
class Tail {
  private lines: string[] = [];
  private partial = "";
  private dropped = false;
  // True while the rest of an overlong line is being discarded.
  private skipping = false;
  private decoder = new TextDecoder();

  feed(chunk: Uint8Array): void {
    let text = this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = text.indexOf("\n");
      if (newline < 0) {
        if (!this.skipping) this.partial += text;
        break;
      }
      if (!this.skipping) this.partial += text.slice(0, newline);
      this.add(capLine(this.partial));
      this.partial = "";
      this.skipping = false;
      text = text.slice(newline + 1);
    }
    if (!this.skipping && this.partial.length > MAX_LINE_CHARS) {
      this.partial = `${this.partial.slice(0, MAX_LINE_CHARS)} [line cut]`;
      this.skipping = true;
    }
  }

  finish(): void {
    if (!this.skipping) this.partial += this.decoder.decode();
    if (this.partial) this.add(capLine(this.partial));
    this.partial = "";
  }

  text(): string {
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    const shown = this.dropped ? [`[earlier output cut; last ${MAX_LINES} lines shown]`, ...all] : all;
    return shown.join("\n");
  }

  private add(line: string): void {
    this.lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (this.lines.length > MAX_LINES) {
      this.lines.shift();
      this.dropped = true;
    }
  }
}

export interface Job {
  id: number;
  command: string;
  pid: number;
  status: "running" | "exited" | "killed";
  exitCode?: number;
  stdout: Tail;
  stderr: Tail;
  // Resolves when the process has exited.
  exited: Promise<number>;
  // Resolves when both output streams have been read to their end. A child process that keeps
  // a stream open keeps this pending.
  drained: Promise<void>;
}

const jobs = new Map<number, Job>();
let nextId = 1;

// Reads a stream into a tail until it ends. A stream cut off when its process stops simply ends here.
function pump(stream: ReadableStream<Uint8Array>, tail: Tail): Promise<void> {
  return (async () => {
    try {
      for await (const chunk of stream) tail.feed(chunk);
    } catch {
      // the stream was closed under us
    }
    tail.finish();
  })();
}

// Registers a running process as a job, reading its output in the background.
export function startJob(command: string, proc: Process): Job {
  const stdout = new Tail();
  const stderr = new Tail();
  const job: Job = {
    id: nextId++,
    command,
    pid: proc.pid,
    status: "running",
    stdout,
    stderr,
    exited: proc.exited,
    drained: Promise.all([pump(proc.stdout, stdout), pump(proc.stderr, stderr)]).then(() => undefined),
  };
  job.exited = proc.exited.then((code) => {
    if (job.status === "running") job.status = "exited";
    job.exitCode = code;
    return code;
  });
  jobs.set(job.id, job);
  return job;
}

// The output of a job so far: stdout, then stderr. Empty when nothing has been printed.
export function outputText(job: Job): string {
  const stderr = job.stderr.text();
  return [job.stdout.text(), stderr ? `stderr:\n${stderr}` : ""].filter(Boolean).join("\n");
}

export function runningJobs(): number {
  return [...jobs.values()].filter((job) => job.status === "running").length;
}

// The status and output of a job, for the model to read. A job that has ended is removed
// once its output has been read.
export function readJob(id: number): Result<string> {
  const job = jobs.get(id);
  if (!job) return err(new Error(`no job ${id}`));
  const state = job.status === "running" ? "running" : job.status === "killed" ? "killed" : `exited with code ${job.exitCode}`;
  const text = [`job ${id}: ${state}`, outputText(job) || "(no output yet)"].join("\n");
  if (job.status !== "running") jobs.delete(id);
  return ok(text);
}

// Stops a running job and every process it started. The job counts as stopped only when
// the stop succeeds; otherwise it stays running, so session end tries again.
export async function killJob(id: number, stop: StopTree = stopTree): Promise<Result<string>> {
  const job = jobs.get(id);
  if (!job) return err(new Error(`no job ${id}`));
  if (job.status !== "running") return err(new Error(`job ${id} is not running`));
  if (!(await stop(job.pid))) return err(new Error(`could not stop job ${id}; it may still be running`));
  if (job.status === "running") job.status = "killed";
  return ok(`job ${id} stopped`);
}

// Stops every running job, retrying those that failed to stop. Returns the jobs that could not
// be stopped, so the caller can report them. The registry is emptied afterwards.
export async function killAllJobs(stop: StopTree = stopTree): Promise<UnstoppedJob[]> {
  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt++) {
    const running = [...jobs.values()].filter((job) => job.status === "running");
    if (running.length === 0) break;
    await Promise.all(running.map((job) => killJob(job.id, stop)));
  }
  const unstopped = [...jobs.values()]
    .filter((job) => job.status === "running")
    .map((job) => ({ id: job.id, pid: job.pid, command: job.command }));
  jobs.clear();
  return unstopped;
}

// Stops a process and every process it started. Returns whether taskkill succeeded. Windows only.
async function stopTree(pid: number): Promise<boolean> {
  try {
    return (await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
}
