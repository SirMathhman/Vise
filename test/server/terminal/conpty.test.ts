import { describe, expect, test } from "bun:test";
import { spawnConPty, type PtyProcess } from "../../../apps/web/src/terminal/pty.ts";

const exited = (pty: PtyProcess, output: string[]): Promise<number> =>
  new Promise((resolve) => {
    pty.onData((text) => output.push(text));
    pty.onExit(resolve);
  });

// Real pseudo consoles: Windows only.
describe.skipIf(process.platform !== "win32")("ConPTY", () => {
  test("runs a command and reports its output and exit code", async () => {
    const output: string[] = [];
    const pty = spawnConPty({
      command: "cmd.exe /d /c echo vise-ok",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    expect(pty.pid).toBeGreaterThan(0);
    expect(await exited(pty, output)).toBe(0);
    expect(output.join("")).toContain("vise-ok");
  }, 15_000);

  test("takes input, resizes and can be stopped", async () => {
    const output: string[] = [];
    const pty = spawnConPty({ command: "cmd.exe /d /q", cwd: process.cwd(), cols: 80, rows: 24 });
    const done = exited(pty, output);
    pty.resize(100, 30);
    pty.write("echo typed-%PROCESSOR_ARCHITECTURE:~0,0%ok\r");
    for (let i = 0; i < 100 && !output.join("").includes("typed-ok"); i++) await Bun.sleep(50);
    expect(output.join("")).toContain("typed-ok");
    pty.kill();
    pty.kill();
    expect(await done).toBeNumber();
  }, 15_000);
});
