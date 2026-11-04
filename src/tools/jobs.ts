import { err, ok, type Result } from "../core/result.ts";
import { MAX_LINES } from "../core/tools.ts";

export const MAX_JOBS = 5;

type Process = Bun.Subprocess<"ignore", "pipe", "pipe">;

// The last MAX_LINES lines of one output stream. Older lines are dropped and the text says so.
class Tail {
  private lines: string[] = [];
  private partial = "";
  private dropped = false;
  private decoder = new TextDecoder();

  feed(chunk: Uint8Array): void {
    const pieces = (this.partial + this.decoder.decode(chunk, { stream: true })).split("\n");
    this.partial = pieces.pop() ?? "";
    for (const line of pieces) this.add(line);
  }

  finish(): void {
    const rest = this.partial + this.decoder.decode();
    this.partial = "";
    if (rest) this.add(rest);
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

// The status and output of a job, for the model to read.
export function readJob(id: number): Result<string> {
  const job = jobs.get(id);
  if (!job) return err(new Error(`no job ${id}`));
  const state = job.status === "running" ? "running" : job.status === "killed" ? "killed" : `exited with code ${job.exitCode}`;
  return ok([`job ${id}: ${state}`, outputText(job) || "(no output yet)"].join("\n"));
}

// Stops a running job and every process it started. Errors are ignored because the process may already be gone.
export async function killJob(id: number): Promise<Result<string>> {
  const job = jobs.get(id);
  if (!job) return err(new Error(`no job ${id}`));
  if (job.status !== "running") return err(new Error(`job ${id} is not running`));
  job.status = "killed";
  await stopTree(job.pid);
  return ok(`job ${id} stopped`);
}

// Stops every running job. Called when the session ends, so no process is left behind.
export async function killAllJobs(): Promise<void> {
  const running = [...jobs.values()].filter((job) => job.status === "running");
  await Promise.all(running.map((job) => killJob(job.id)));
}

// Stops a process and every process it started. Windows only.
async function stopTree(pid: number): Promise<void> {
  try {
    await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    // nothing to stop
  }
}
