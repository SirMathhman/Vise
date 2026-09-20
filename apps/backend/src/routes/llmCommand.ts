import { type ChildProcess, execSync, spawn } from "node:child_process";
import { AppError, badRequest } from "../errors.js";
import type { LlmToolHandler } from "./llmToolTypes.js";

/** The maximum combined output (bytes) a run_command call may return. */
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

/** How long a run_command call may run before it is killed as hung. */
const COMMAND_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Kills a spawned process and its entire process tree. On Windows,
 * `child.kill()` signals only the top-level process (e.g. powershell.exe);
 * any descendants (node, pnpm, git, …) survive and keep running. We kill the
 * tree with `taskkill /T /F` so a hung command (and its children) die together.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
  } catch {
    // The process may already have exited; fall back to a plain kill.
    child.kill();
  }
}

/**
 * Spawn a PowerShell command in the workspace root with -NoProfile and
 * -NonInteractive (fast, free of the user's profile side effects, and never
 * blocked on a prompt). Thrown synchronously from a bad spawn (a missing cwd,
 * a NUL byte in the command, …) — the caller decides how to surface it. Shared
 * by runShellCommand (foreground) and startBackgroundCommand (background) so
 * the spawn flags stay defined in one place.
 */
function spawnPowershell(command: string, root: string): ChildProcess {
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { cwd: root }
  );
}

/** The structured result of running a bounded PowerShell command. */
interface CommandResult {
  stdout: string;
  stderr: string;
  /** True when combined output hit MAX_OUTPUT_BYTES and was cut off. */
  truncated: boolean;
  /** True when the command was killed for exceeding COMMAND_TIMEOUT_MS. */
  timedOut: boolean;
  /** "exit N" or "signal X"; meaningless (the process never exited normally) when timedOut. */
  status: string;
}

/**
 * Run a PowerShell command in the workspace root and resolve its stdout,
 * stderr, and exit status, kept distinct so a caller can tell a failure's
 * diagnostics apart from normal output. The command runs non-interactively:
 * it is spawned in its own process, given a hard timeout (killed as hung when
 * exceeded, along with its whole process tree), and its stdout/stderr are
 * capped at MAX_OUTPUT_BYTES so a chatty command can't flood the caller. The
 * working directory is the workspace root, matching the file tools, so relative
 * paths in the command resolve against it. Exported so the registry (llm.ts)
 * can also call it from the panel's non-tool /api/llm/hook-command route.
 *
 * Any number may run at once: the old single-flight guard was dropped because
 * a background command (startBackgroundCommand) holds the process open for an
 * unbounded time, so a shared flag could wedge the foreground tools for as
 * long as a background command runs.
 */
export function runShellCommand(
  command: string,
  root: string
): Promise<CommandResult> {
  let child: ChildProcess;
  try {
    child = spawnPowershell(command, root);
  } catch (err) {
    throw new AppError(
      500,
      "spawn_error",
      `failed to run command: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return new Promise<CommandResult>((resolvePromise, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;

    const onChunk = (chunk: Buffer, target: "out" | "err") => {
      if (truncated) return;
      if (target === "out") {
        out.push(chunk);
        outBytes += chunk.length;
      } else {
        err.push(chunk);
        errBytes += chunk.length;
      }
      if (outBytes + errBytes > MAX_OUTPUT_BYTES) truncated = true;
    };
    child.stdout?.on("data", (c: Buffer) => onChunk(c, "out"));
    child.stderr?.on("data", (c: Buffer) => onChunk(c, "err"));

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, COMMAND_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new AppError(
          500,
          "spawn_error",
          `failed to run command: ${err.message}`
        )
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf-8").trimEnd();
      const stderr = Buffer.concat(err).toString("utf-8").trimEnd();
      const status = signal != null ? `signal ${signal}` : `exit ${code ?? 0}`;
      resolvePromise({ stdout, stderr, truncated, timedOut, status });
    });
  });
}

/**
 * A long-running command started by run_command_background. Unlike the
 * bounded foreground command, it has no timeout and may run alongside any
 * number of siblings; callers observe it through wait_for_command.
 */
interface BackgroundCommand {
  id: number;
  command: string;
  child: ChildProcess;
  out: Buffer[];
  err: Buffer[];
  outBytes: number;
  errBytes: number;
  /** "exit N" | "signal X" | "killed" | "spawn_error"; set when settled. */
  status: string;
  /** True once the process has exited (naturally, or via kill). */
  settled: boolean;
  /** True when terminated by killBackgroundCommand rather than exiting itself. */
  killed: boolean;
  /** Settled as soon as the process exits; resolves with the result. */
  done: Promise<CommandResult>;
}
/** A snapshot of a background command's state, as the model reads it back. */
interface BackgroundCommandStatus {
  id: number;
  command: string;
  running: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  status: string;
  killed: boolean;
}
const backgroundCommands = new Map<number, BackgroundCommand>();
let nextBackgroundId = 1;

/** Start a command in the background and return its id (as a string). */
export function startBackgroundCommand(command: string, root: string): string {
  let child: ChildProcess;
  try {
    child = spawnPowershell(command, root);
  } catch (err) {
    throw new AppError(
      500,
      "spawn_error",
      `failed to run command: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const id = nextBackgroundId++;
  const done = new Promise<CommandResult>((resolvePromise, reject) => {
    child.on("error", (err) => {
      if (!bg.settled) {
        bg.settled = true;
        bg.status = "spawn_error";
      }
      reject(
        new AppError(
          500,
          "spawn_error",
          `failed to run command: ${err.message}`
        )
      );
    });
    child.on("close", (code, signal) => {
      if (!bg.killed) {
        bg.status = signal != null ? `signal ${signal}` : `exit ${code ?? 0}`;
      }
      bg.settled = true;
      const stdout = Buffer.concat(bg.out).toString("utf-8").trimEnd();
      const stderr = Buffer.concat(bg.err).toString("utf-8").trimEnd();
      resolvePromise({
        stdout,
        stderr,
        truncated: false,
        timedOut: false,
        status: bg.status,
      });
    });
  });
  // The promise can reject (error event) at a moment when nobody is awaiting
  // it — e.g. right after start, or after a kill — which would otherwise be
  // an unhandled rejection. The error is already surfaced through the
  // wait/kill status, so swallow it here.
  done.catch(() => undefined);
  const bg: BackgroundCommand = {
    id,
    command,
    child,
    out: [],
    err: [],
    outBytes: 0,
    errBytes: 0,
    status: "",
    settled: false,
    killed: false,
    done,
  };
  // Cap each stream at MAX_OUTPUT_BYTES so a chatty long-running command
  // (a verbose test run) can't grow memory without bound.
  const onChunk = (chunk: Buffer, target: "out" | "err") => {
    const used = target === "out" ? bg.outBytes : bg.errBytes;
    if (used >= MAX_OUTPUT_BYTES) return;
    const allowed = Math.min(chunk.length, MAX_OUTPUT_BYTES - used);
    const piece = chunk.subarray(0, allowed);
    if (piece.length === 0) return;
    if (target === "out") {
      bg.out.push(piece);
      bg.outBytes += piece.length;
    } else {
      bg.err.push(piece);
      bg.errBytes += piece.length;
    }
  };
  child.stdout?.on("data", (c: Buffer) => onChunk(c, "out"));
  child.stderr?.on("data", (c: Buffer) => onChunk(c, "err"));
  backgroundCommands.set(id, bg);
  return String(id);
}

/**
 * Snapshot a background command's current state (running or not). Truncation
 * is reported per stream: each is capped independently at MAX_OUTPUT_BYTES.
 */
function formatBackground(bg: BackgroundCommand): BackgroundCommandStatus {
  const stdout = Buffer.concat(bg.out).toString("utf-8").trimEnd();
  const stderr = Buffer.concat(bg.err).toString("utf-8").trimEnd();
  return {
    id: bg.id,
    command: bg.command,
    running: !bg.settled,
    stdout,
    stderr,
    truncated:
      bg.outBytes >= MAX_OUTPUT_BYTES || bg.errBytes >= MAX_OUTPUT_BYTES,
    status: bg.status,
    killed: bg.killed,
  };
}

/**
 * Wait for a background command to finish, returning its state. Resolves with
 * the final result if it has already settled (or settles within timeoutMs),
 * otherwise with the current state (still running, with output so far) after
 * timeoutMs. A mandatory timeoutMs keeps a hung command from blocking a turn
 * indefinitely — the model can then check on it or kill it.
 */
export function waitBackgroundCommand(
  id: number,
  timeoutMs: number
): Promise<BackgroundCommandStatus> {
  const bg = backgroundCommands.get(id);
  if (!bg) throw badRequest(`no background command with id ${id}`);
  return new Promise<BackgroundCommandStatus>((resolvePromise) => {
    const timer = setTimeout(
      () => resolvePromise(formatBackground(bg)),
      timeoutMs
    );
    bg.done.then(
      () => {
        clearTimeout(timer);
        resolvePromise(formatBackground(bg));
      },
      () => {
        clearTimeout(timer);
        resolvePromise(formatBackground(bg));
      }
    );
  });
}

/** Terminate a background command and its process tree; report its state. */
export function killBackgroundCommand(id: number): BackgroundCommandStatus {
  const bg = backgroundCommands.get(id);
  if (!bg) throw badRequest(`no background command with id ${id}`);
  if (!bg.settled) {
    bg.killed = true;
    bg.status = "killed";
    bg.settled = true;
    killProcessTree(bg.child);
  }
  return formatBackground(bg);
}

/**
 * Kill any live background command and clear the registry, so none outlive
 * the backend (a background dev server would otherwise keep running as an
 * orphan after shutdown, and settled entries would accumulate for the life
 * of a long dev session). Called from the app's close() alongside the other
 * long-lived app-owned resources (the file watcher and the browser session).
 */
export function closeBackgroundCommands(): void {
  for (const bg of backgroundCommands.values()) {
    if (!bg.settled) {
      bg.killed = true;
      bg.status = "killed";
      bg.settled = true;
      killProcessTree(bg.child);
    }
  }
  backgroundCommands.clear();
  nextBackgroundId = 1;
}

/**
 * Run a PowerShell command in the workspace root and return its combined
 * output and exit status as model-readable text (see runShellCommand for the
 * execution details this formats).
 */
export const runCommand: LlmToolHandler = async (args, root) => {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command) throw badRequest("command is required");
  const r = await runShellCommand(command, root);
  const combined = r.stderr ? `${r.stdout}\n[stderr]\n${r.stderr}` : r.stdout;
  const body = r.truncated
    ? `${combined.slice(0, MAX_OUTPUT_BYTES)}\n… (output capped at ${MAX_OUTPUT_BYTES} bytes)`
    : combined;
  if (r.timedOut) {
    return `$ ${command}\ntimed out after ${COMMAND_TIMEOUT_MS / 1000}s\n${body}`;
  }
  return `$ ${command}\n${r.status}\n${body}`.trimEnd();
};

/**
 * Start a PowerShell command in the background and return its id, so the
 * caller can later wait for it or kill it with wait_for_command. For long
 * commands — a test run, a build, a dev-server — that would not fit run_command's
 * 30-second foreground timeout. The command has no timeout and may run
 * alongside any number of siblings; its stdout/stderr are each capped at
 * MAX_OUTPUT_BYTES and returned incrementally as the model waits.
 */
export const runCommandBackground: LlmToolHandler = async (args, root) => {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command) throw badRequest("command is required");
  const id = startBackgroundCommand(command, root);
  return `${id}: started in the background (no timeout). Use wait_for_command with id ${id} to wait for it or kill it.`;
};

/**
 * Wait for a background command to finish, or terminate it. Takes the id
 * returned by run_command_background, a mandatory timeoutMs (how long to wait
 * before returning "still running"), and an optional action: "kill" to
 * terminate it immediately (returning its final state) or the default "wait"
 * to observe it. Returns the command's output and status so far — on a
 * timeout with the process still alive, the result carries running: true
 * and the output accumulated up to that point, so the model can wait again
 * with a larger timeout, check on it, or kill it.
 */
export const waitForCommand: LlmToolHandler = async (args, _root) => {
  const rawId = typeof args.id === "string" ? args.id : String(args.id ?? "");
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || Number.isNaN(id) || !backgroundCommands.has(id)) {
    throw badRequest(`no background command with id ${rawId}`);
  }
  const timeoutMs = Number(args.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw badRequest(
      "timeoutMs is required and must be a positive number (milliseconds)"
    );
  }
  const action = typeof args.action === "string" ? args.action : "wait";
  if (action === "kill") {
    const status = killBackgroundCommand(id);
    return formatKillResult(status);
  }
  if (action !== "wait") {
    throw badRequest(`action must be "wait" or "kill" (got "${action}")`);
  }
  const status = await waitBackgroundCommand(id, timeoutMs);
  if (status.running) {
    const body = formatBackgroundOutput(status);
    return `${status.id}: still running after ${timeoutMs}ms.\n${body}`;
  }
  return formatBackgroundOutput(status);
};

/** Format a background command's status as model-readable text. */
function formatBackgroundOutput(status: BackgroundCommandStatus): string {
  const header = status.killed
    ? `${status.id}: killed`
    : `${status.id}: ${status.status}`;
  const combined = status.stderr
    ? `${status.stdout}\n[stderr]\n${status.stderr}`
    : status.stdout;
  const note = status.truncated
    ? `\n… (output capped at ${MAX_OUTPUT_BYTES} bytes per stream)`
    : "";
  return `${header}\n${combined}${note}`.trimEnd();
}

/** Format a kill result as model-readable text. */
function formatKillResult(status: BackgroundCommandStatus): string {
  const combined = status.stderr
    ? `${status.stdout}\n[stderr]\n${status.stderr}`
    : status.stdout;
  const note = status.truncated
    ? `\n… (output capped at ${MAX_OUTPUT_BYTES} bytes per stream)`
    : "";
  return `${status.id}: killed\n${combined}${note}`.trimEnd();
}
