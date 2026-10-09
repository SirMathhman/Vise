import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpConnection } from "../../src/mcp/mcp-connection.ts";

const fixture = join(import.meta.dir, "fixture-server.ts");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("closing a connection while it connects leaves no process behind", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "mcp-pid-")), "pid");
  const conn = new McpConnection(
    "fx",
    {
      command: process.execPath,
      args: [fixture],
      env: { FIXTURE_PIDFILE: pidFile },
    },
    import.meta.dir,
  );
  const connecting = conn.connect();
  await conn.close();
  await connecting;

  expect(conn.status.state).not.toBe("ready");
  // The server may have been stopped before it wrote its pid; if it did, it must be gone now.
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await Bun.sleep(20);
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(50);
    expect(alive(pid)).toBe(false);
  }
});
