import { spawn } from "node:child_process";
import { errStr } from "./files.ts";

export async function runPowershell(
  args: Record<string, unknown>,
): Promise<string> {
  const command = String(args.command ?? "");
  if (command === "") return `error: command must not be empty`;
  try {
    const res = await new Promise<{
      status: number;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
      }, 60_000);
      proc.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      proc.on("close", (status) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ status: -1, stdout, stderr });
        } else {
          resolve({ status: status ?? -1, stdout, stderr });
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const exitCode = res.status;
    const stdout = res.stdout;
    const stderr = res.stderr;
    const body = [stdout.trim(), stderr.trim()]
      .filter((s) => s !== "")
      .join("\n");
    if (exitCode !== 0) {
      return `exit code ${exitCode}\n${body}`.trim();
    }
    return body;
  } catch (err) {
    return errStr(err);
  }
}
