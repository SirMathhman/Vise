import { randomUUID } from "node:crypto";
import { err, ok, type Result } from "../../core/messages.ts";
import { outputText, startJob } from "../process/jobs.ts";
import { timer } from "../process/timer.ts";
import { podman } from "./podman.ts";

const TIMEOUT_MS = 30_000;
// How long to wait for a finished command's output to finish arriving before returning it.
const GRACE_MS = 1_000;

// The shell script that runs a command in the container. It records the pid of the shell that runs the
// command, so a stop can reach it. The command is passed as an argument, never as part of the script.
const SCRIPT = 'echo $$ > "$1"; exec sh -c "$2"';

// Runs a shell command in the session container, in /work, the same way run_powershell runs a command on the
// host: a command still running at the timeout becomes a background job, which read_command and kill_command
// follow. Killing the job stops the command inside the container too.
export async function runInContainer(
  name: string,
  command: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Result<string>> {
  const pidFile = `/tmp/vise-${randomUUID()}.pid`;
  try {
    const proc = Bun.spawn(
      ["podman", "exec", "-w", "/work", name, "sh", "-c", SCRIPT, "sh", pidFile, command],
      { stdout: "pipe", stderr: "pipe" },
    );
    const job = startJob(command, proc);
    job.stopWithin = async () =>
      (await podman(["exec", name, "sh", "-c", 'kill "$(cat "$1")" 2>/dev/null; true', "sh", pidFile])).ok;
    const limit = timer(timeoutMs);
    const outcome = await Promise.race([job.exited.then(() => "exited" as const), limit.done]);
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
    return ok([outputText(job), `[exit code ${job.exitCode}]`].filter(Boolean).join("\n"));
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
