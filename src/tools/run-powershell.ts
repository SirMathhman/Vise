import { err, ok, type Result } from "../core/messages.ts";
import { startJob, outputText } from "./jobs.ts";
import { childEnvironment } from "./child-env.ts";

const TIMEOUT_MS = 30_000;
// How long to wait for a finished command's output to finish arriving before returning it.
const GRACE_MS = 1_000;

// Runs a PowerShell command in `root`. A command that finishes within `timeoutMs` returns its
// output and exit code. One still running at the timeout keeps running as a background job: the
// result is its output so far and its job number, and read_command or kill_command follow it.
export async function runPowershell(
  root: string,
  command: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Result<string>> {
  try {
    const proc = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd: root,
        env: childEnvironment(process.env),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const job = startJob(command, proc);
    const limit = timer(timeoutMs);
    const outcome = await Promise.race([
      job.exited.then(() => "exited" as const),
      limit.done,
    ]);
    limit.cancel();
    if (outcome === "timeout") {
      return ok(
        [
          outputText(job),
          `[still running after ${timeoutMs / 1000} seconds as job ${job.id}; use read_command to read its output or kill_command to stop it]`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    const grace = timer(GRACE_MS);
    await Promise.race([job.drained, grace.done]);
    grace.cancel();
    return ok(
      [outputText(job), `[exit code ${job.exitCode}]`]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// A timer that can be cancelled. `done` resolves to "timeout" when it fires.
interface Timer {
  done: Promise<"timeout">;
  cancel(): void;
}

function timer(ms: number): Timer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { done, cancel: () => clearTimeout(handle) };
}
