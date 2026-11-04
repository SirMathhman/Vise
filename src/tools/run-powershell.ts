import { err, ok, type Result } from "../core/result.ts";
import { MAX_LINES } from "../core/tools.ts";

const TIMEOUT_MS = 30_000;
// How long to read what has arrived after the process stops or exits, before returning.
const GRACE_MS = 1_000;
// Each stream keeps this many characters. The rest is read and discarded, so the command never blocks.
const CAP_CHARS = 256 * 1024;

interface Capture {
  text: string;
  cut: boolean;
  finished: Promise<void>;
}

// Reads a stream in the background, keeping at most CAP_CHARS characters of it.
function capture(stream: ReadableStream<Uint8Array>): Capture {
  const captured: Capture = { text: "", cut: false, finished: Promise.resolve() };
  const decoder = new TextDecoder();
  captured.finished = (async () => {
    try {
      for await (const chunk of stream) {
        if (captured.cut) continue;
        captured.text += decoder.decode(chunk, { stream: true });
        if (captured.text.length > CAP_CHARS) {
          captured.text = captured.text.slice(0, CAP_CHARS);
          captured.cut = true;
        }
      }
    } catch {
      // A stream that is cut off when the process is stopped simply ends here.
    }
  })();
  return captured;
}

// Formats one stream: its lines, cut to MAX_LINES, with a note when the stream was cut.
function section(captured: Capture, label: string | undefined): string {
  const lines = captured.text.trimEnd() ? captured.text.trimEnd().split("\n") : [];
  const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `[${label ?? "output"} cut at ${MAX_LINES} lines]`] : lines;
  if (captured.cut) shown.push(`[${label ?? "output"} cut at ${CAP_CHARS} characters]`);
  return shown.join("\n");
}

// Stops a process and every process it started. Windows only; errors are ignored because the
// process may already be gone.
async function stopTree(pid: number): Promise<void> {
  try {
    await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    // nothing to stop
  }
}

// Runs a PowerShell command in `root`. The result is the standard output, then the standard
// error (kept even when the output was long), each cut as described, then the exit code. When the
// command is still running after `timeoutMs`, its process tree is stopped and the call returns after
// a short grace period, whether or not the command's children have closed their output.
export async function runPowershell(root: string, command: string, timeoutMs = TIMEOUT_MS): Promise<Result<string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = capture(proc.stdout);
    const errOut = capture(proc.stderr);
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([proc.exited, timeout]);
    const stopped = outcome === "timeout";
    if (stopped) await stopTree(proc.pid);
    await Promise.race([Promise.all([out.finished, errOut.finished]), new Promise((resolve) => setTimeout(resolve, GRACE_MS))]);
    const stdout = section(out, undefined);
    const stderr = errOut.text.trim() ? `stderr:\n${section(errOut, "stderr")}` : "";
    const status = stopped ? `[stopped after ${timeoutMs / 1000} seconds]` : `[exit code ${outcome}]`;
    return ok([stdout, stderr, status].filter(Boolean).join("\n"));
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  } finally {
    clearTimeout(timer);
  }
}
