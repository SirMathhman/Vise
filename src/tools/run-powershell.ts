import { err, ok, type Result } from "../core/result.ts";
import { MAX_LINES } from "../core/tools.ts";

const TIMEOUT_MS = 30_000;

// Runs a PowerShell command in `root`. The result is the standard output, then the standard
// error, cut to MAX_LINES lines, then the exit code. A command still running after TIMEOUT_MS is stopped.
export async function runPowershell(root: string, command: string): Promise<Result<string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = [stdout.trimEnd(), stderr.trim() ? `stderr:\n${stderr.trimEnd()}` : ""].filter(Boolean).join("\n");
    const lines = output ? output.split("\n") : [];
    const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `[output cut at ${MAX_LINES} lines]`] : lines;
    const status = timedOut ? "[stopped after 30 seconds]" : `[exit code ${code}]`;
    return ok([...shown, status].join("\n"));
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  } finally {
    clearTimeout(timer);
  }
}
