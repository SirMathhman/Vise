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
 * Concurrency guard: at most one command runs at a time. A single model reply
 * can contain multiple tool_calls, and overlapping turns must not pile up
 * parallel shells. Returns false (so the caller can reject) when a command is
 * already in flight.
 */
let commandInFlight = false;

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
 * capped at MAX_OUTPUT_BYTES so a chatty command can't flood the caller. At
 * most one command runs at a time (across every caller — the LLM tool and any
 * hook). The working directory is the workspace root, matching the file
 * tools, so relative paths in the command resolve against it. Exported so the
 * registry (llm.ts) can also call it from the panel's non-tool
 * /api/llm/hook-command route.
 */
export function runShellCommand(
  command: string,
  root: string
): Promise<CommandResult> {
  if (commandInFlight) {
    throw badRequest("a command is already running; wait for it to finish");
  }

  return new Promise<CommandResult>((resolvePromise, reject) => {
    // -NoProfile keeps it fast and free of the user's profile side effects;
    // -NonInteractive prevents any prompt from blocking the process.
    commandInFlight = true;
    // spawn can throw synchronously (e.g. a bad cwd, or a NUL byte in the
    // command); in that case no child is created so the close/error handlers
    // below never fire — reset the flag here or it wedges run_command forever.
    let child: ChildProcess;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { cwd: root }
      );
    } catch (err) {
      commandInFlight = false;
      reject(
        new AppError(
          500,
          "spawn_error",
          `failed to run command: ${err instanceof Error ? err.message : String(err)}`
        )
      );
      return;
    }

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

    const finish = () => {
      commandInFlight = false;
    };

    child.on("error", (err) => {
      clearTimeout(timer);
      finish();
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
      finish();
      const stdout = Buffer.concat(out).toString("utf-8").trimEnd();
      const stderr = Buffer.concat(err).toString("utf-8").trimEnd();
      const status = signal != null ? `signal ${signal}` : `exit ${code ?? 0}`;
      resolvePromise({ stdout, stderr, truncated, timedOut, status });
    });
  });
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
