import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpHub } from "../../packages/backend/src/mcp/mcp-hub.ts";
import {
  readEntries,
  removeEntry,
  saveEntry,
  type McpEntry,
} from "../../packages/backend/src/mcp/mcp-store.ts";
import { handleMcpMessage } from "../../apps/web/src/api/mcp-api.ts";

const fixture = join(import.meta.dir, "fixture-server.ts");
const entry = (over: Partial<McpEntry> = {}): McpEntry => ({
  name: "fx",
  scope: "project",
  command: process.execPath,
  args: [fixture],
  env: {},
  disabled: false,
  ...over,
});

test("saving keeps the file's other keys; rename and removal edit the right scope", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-store-"));
  const global = mkdtempSync(join(tmpdir(), "mcp-store-g-"));
  writeFileSync(join(root, ".viserc.json"), JSON.stringify({ preTurnCommand: "x" }));

  expect(saveEntry(entry(), undefined, root, global).ok).toBe(true);
  expect(saveEntry(entry(), undefined, root, global).ok).toBe(false); // duplicate name
  expect(
    saveEntry(entry({ name: "renamed" }), { name: "fx", scope: "project" }, root, global).ok,
  ).toBe(true);
  expect(
    saveEntry(entry({ name: "g", scope: "global", disabled: true }), undefined, root, global).ok,
  ).toBe(true);

  const names = readEntries(root, global).map((e) => `${e.scope}:${e.name}:${e.disabled}`);
  expect(names).toEqual(["project:renamed:false", "global:g:true"]);
  expect(JSON.parse(readFileSync(join(root, ".viserc.json"), "utf8")).preTurnCommand).toBe("x");

  expect(removeEntry("renamed", "project", root, global).ok).toBe(true);
  expect(readEntries(root, global).map((e) => e.name)).toEqual(["g"]);
});

test("the settings api saves, reconnects the hub, restarts and deletes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-api-"));
  // A temp global folder, so the user's real ~/.vise/mcp.json never takes part.
  const global = mkdtempSync(join(tmpdir(), "mcp-api-g-"));
  const hub = new McpHub(root, { servers: {}, problems: [] }, global);
  await hub.start();
  try {
    const saved = await handleMcpMessage(hub, root, { type: "mcp_save", entry: entry() }, global);
    expect(saved["saved"]).toBe(true);
    const servers = saved["servers"] as { name: string; state: string; tools: number }[];
    expect(servers[0]).toMatchObject({ name: "fx", state: "ready", tools: 3 });
    expect(hub.tools()).toHaveLength(3);

    const restarted = await handleMcpMessage(
      hub,
      root,
      { type: "mcp_restart", name: "fx" },
      global,
    );
    expect(restarted["error"]).toBeUndefined();

    const bad = await handleMcpMessage(
      hub,
      root,
      { type: "mcp_save", entry: entry({ name: "" }) },
      global,
    );
    expect(bad["error"]).toContain("needs a name");

    const gone = await handleMcpMessage(
      hub,
      root,
      { type: "mcp_delete", name: "fx", scope: "project" },
      global,
    );
    expect(gone["servers"]).toEqual([]);
    expect(hub.tools()).toHaveLength(0);
  } finally {
    await hub.close();
  }
});
