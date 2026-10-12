import { config } from "../config.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { numberArg } from "./args.ts";
import { errStr } from "./files.ts";
import { selfKillRefusal } from "./self-kill-guard.ts";

/**
 * Foreground commands that do not finish within this window are killed.
 * Background processes are not subject to this limit.
 */

type ProcessStatus = "running" | "finished" | "killed";

/**
 * Live record for a background process. Foreground processes never enter the
 * registry — they block until close, so the process id is meaningless to
 * them. The registry exists only so that `wait_for_process` / `kill_process`
 * can reach a background process from a later tool call.
 */
interface ProcessRecord {
  /**
   * Live handle while running. Cleared once the process exits so the
   * registry holds no live `ChildProcess` and does not keep the event loop
   * open after the conversation is done.
   */
  proc: ChildProcess | null;
  stdout: string;
  stderr: string;
  status: ProcessStatus;
  exitCode: number | null;
  /**
   * Set to true only when `kill_process` terminated this process. Kept as a
   * separate flag (rather than a value that the `close` handler overwrites)
   * so the "killed by us" distinction survives the process's exit. The
   * `close` handler owns `status` and `exitCode`; this field is owned
   * exclusively by `kill_process`, so the two never race.
   */
  killedByUs: boolean;
}

const processes = new Map<number, ProcessRecord>();
let nextProcessId = 1;

/**
 * Spawns powershell.exe with the given command and wires up the output
 * handlers. Returns the spawn handle; the caller decides whether to wait on
 * it (foreground) or register it (background).
 */
export function spawnPowerShell(
  command: string,
  cwd?: string,
): {
  proc: ChildProcess;
  record: ProcessRecord;
} {
  const proc = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      windowsHide: true,
      cwd,
    },
  );
  const record: ProcessRecord = {
    proc,
    stdout: "",
    stderr: "",
    status: "running",
    exitCode: null,
    killedByUs: false,
  };
  proc.stdout.on("data", (d: Buffer) => {
    record.stdout += d.toString("utf8");
  });
  proc.stderr.on("data", (d: Buffer) => {
    record.stderr += d.toString("utf8");
  });
  return { proc, record };
}

/**
 * Joins the captured stdout and stderr, dropping whichever is empty.
 */
function formatBody(record: ProcessRecord): string {
  return [record.stdout.trim(), record.stderr.trim()]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * The terminal description for a process that is no longer running. A
 * process we killed is reported as "killed" regardless of its raw exit code
 * (a SIGTERM does not produce a meaningful exit status); anything else is
 * reported by exit code, with an empty successful run rendered as
 * "(no output)".
 */
function describeFinished(id: number, record: ProcessRecord): string {
  const body = formatBody(record);
  if (record.killedByUs) {
    return `killed process ${id}\n${body}`.trim();
  }
  if (record.status === "finished" && record.exitCode === 0) {
    return body || "(no output)";
  }
  return `process ${id} exited with code ${record.exitCode ?? -1}\n${body}`.trim();
}

/**
 * `run_powershell`: run a PowerShell command.
 *
 * Foreground (default): blocks until the command exits or the
 * `FOREGROUND_TIMEOUT_MS` deadline fires (whichever first). Returns combined
 * stdout/stderr, or an `exit code <n>` prefix when the command failed.
 *
 * Background (`background: true`): spawns and returns a numeric process id
 * immediately. The id is what `wait_for_process` and `kill_process` take.
 */
export async function runPowershell(
  args: Record<string, unknown>,
  cwd?: string,
): Promise<string> {
  const command = String(args.command ?? "");
  if (command === "") return `error: command must not be empty`;
  const refusal = selfKillRefusal(command);
  if (refusal) return refusal;
  const background = args.background === true;
  try {
    if (background) {
      const { proc, record } = spawnPowerShell(command, cwd);
      const id = nextProcessId++;
      processes.set(id, record);
      proc.on("close", (status) => {
        record.status = "finished";
        record.exitCode = status ?? -1;
        record.proc = null;
      });
      proc.on("error", () => {
        record.status = "killed";
        record.proc = null;
      });
      return String(id);
    }
    const { proc, record } = spawnPowerShell(command, cwd);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, config.shellTimeoutMs);
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      proc.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status: status ?? -1 });
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const exitCode = timedOut ? -1 : result.status;
    const body = formatBody(record);
    if (timedOut) {
      const seconds = Math.round(config.shellTimeoutMs / 1000);
      return `error: timed out after ${seconds} s (use background: true for long commands)\n${body}`.trim();
    }
    if (exitCode !== 0) {
      return `exit code ${exitCode}\n${body}`.trim();
    }
    return body;
  } catch (err) {
    return errStr(err);
  }
}

/**
 * `wait_for_process`: block until the background process with `process_id`
 * exits, or up to `timeout` milliseconds. A timeout of 0 returns the current
 * status immediately without waiting. If the process finished within the
 * window the result is the exit code plus captured output; if the timeout
 * elapses first, the result reports that the process is still running and
 * includes whatever output has been produced so far. Either way the process
 * keeps running afterwards (a wait does not kill it).
 */
export function waitForProcess(args: Record<string, unknown>): Promise<string> {
  const id = numberArg(args.process_id);
  if (id === undefined || !Number.isInteger(id) || id < 1) {
    return Promise.resolve("error: process_id must be a positive integer");
  }
  const record = processes.get(id);
  if (record === undefined) {
    return Promise.resolve(`error: no process ${id}`);
  }
  // The timeout is optional: omitted means "do not wait" (0).
  const timeout = numberArg(args.timeout) ?? 0;
  if (
    !Number.isFinite(timeout) ||
    timeout < 0 ||
    Math.floor(timeout) !== timeout
  ) {
    return Promise.resolve("error: timeout must be a non-negative number");
  }
  if (record.status !== "running") {
    return Promise.resolve(describeFinished(id, record));
  }

  if (timeout === 0) {
    return Promise.resolve(
      `still running; output so far:\n${formatBody(record)}`.trim(),
    );
  }
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      resolve(
        `still running after ${timeout} ms; output so far:\n${formatBody(record)}`.trim(),
      );
    }, timeout);
    const onDone = () => {
      clearTimeout(timer);
      const body = formatBody(record);
      if (record.killedByUs) {
        resolve(`killed process ${id}\n${body}`.trim());
      } else if (record.status === "finished" && record.exitCode === 0) {
        resolve(body || "(no output)");
      } else {
        resolve(`exit code ${record.exitCode ?? -1}\n${body}`.trim());
      }
    };
    // Guard against double-resolution if both handlers fire.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      onDone();
    };
    const proc = record.proc;
    if (proc === null) {
      // Process already exited between the status check and here.
      settle();
      return;
    }
    proc.on("close", settle);
    proc.on("error", settle);
  });
}

/**
 * `kill_process`: send SIGTERM to the background process with `process_id`
 * and return a confirmation plus whatever output was captured before it
 * died. Idempotent: a kill against an already-finished process returns a
 * short "no longer running" message.
 */
export function killProcess(args: Record<string, unknown>): string {
  const id = numberArg(args.process_id);
  if (id === undefined || !Number.isInteger(id) || id < 1) {
    return "error: process_id must be a positive integer";
  }
  const record = processes.get(id);
  if (record === undefined) {
    return `process ${id} is no longer running`;
  }
  if (record.status !== "running") {
    return describeFinished(id, record);
  }
  const proc = record.proc;
  if (proc !== null) {
    record.killedByUs = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already reaped; the close handler has updated the record.
    }
  }
  return `killed process ${id}`;
}
