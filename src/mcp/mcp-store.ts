import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "../core/errors.ts";
import { globalDataDir } from "../data-dir.ts";
import { parseServer } from "./mcp-config.ts";

export type McpScope = "project" | "global";

/** One configured server as the settings page edits it. */
export interface McpEntry {
  name: string;
  scope: McpScope;
  disabled: boolean;
  /** A local server (stdio)... */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** ...or a remote one. */
  url?: string;
  headers?: Record<string, string>;
}

const fail = (body: string): Result<void> => ({
  ok: false,
  error: { kind: "malformed", body },
});

/** The file that holds `scope`'s servers: the project's `.viserc.json` or the global `mcp.json`. */
export function mcpFile(
  scope: McpScope,
  root: string,
  globalDir: string = globalDataDir,
): string {
  return scope === "global"
    ? join(globalDir, "mcp.json")
    : join(root, ".viserc.json");
}

function readFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the file does not hold a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Every valid server entry of both files (entries that fail validation are left out; the hub reports them). */
export function readEntries(
  root: string,
  globalDir: string = globalDataDir,
): McpEntry[] {
  const out: McpEntry[] = [];
  for (const scope of ["project", "global"] as const) {
    let servers: unknown;
    try {
      servers = readFile(mcpFile(scope, root, globalDir))["mcpServers"];
    } catch {
      continue;
    }
    if (typeof servers !== "object" || servers === null) continue;
    for (const [name, value] of Object.entries(servers)) {
      const spec = parseServer(value);
      if (typeof spec === "string") continue;
      const disabled = (value as Record<string, unknown>)["disabled"] === true;
      out.push({ name, scope, disabled, ...spec });
    }
  }
  return out;
}

/** Change the `mcpServers` object of one file, keeping its other keys; written through a temp file and a rename. */
function edit(
  path: string,
  change: (servers: Record<string, unknown>) => void,
): Result<void> {
  try {
    const file = readFile(path);
    const servers = (file["mcpServers"] ?? {}) as Record<string, unknown>;
    change(servers);
    if (Object.keys(servers).length === 0) delete file["mcpServers"];
    else file["mcpServers"] = servers;
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temp, path);
    return { ok: true, value: undefined };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return fail(`cannot save ${path}: ${reason}`);
  }
}

/** Save `entry`; `previous` is the entry it replaces (a rename or a move between scopes removes the old one). */
export function saveEntry(
  entry: McpEntry,
  previous: { name: string; scope: McpScope } | undefined,
  root: string,
  globalDir: string = globalDataDir,
): Result<void> {
  const name = entry.name.trim();
  if (name === "") return fail("a server needs a name");
  const spec = parseServer(entry);
  if (typeof spec === "string") return fail(spec);
  const moved =
    previous !== undefined &&
    (previous.name !== name || previous.scope !== entry.scope);
  const taken = readEntries(root, globalDir).some(
    (e) => e.name === name && e.scope === entry.scope,
  );
  if ((!previous || moved) && taken) {
    return fail(`a ${entry.scope} server named ${name} already exists`);
  }
  const written = edit(mcpFile(entry.scope, root, globalDir), (servers) => {
    servers[name] = { ...spec, ...(entry.disabled ? { disabled: true } : {}) };
  });
  if (!written.ok || !moved || !previous) return written;
  return removeEntry(previous.name, previous.scope, root, globalDir);
}

/** Remove the named server from one scope's file. */
export function removeEntry(
  name: string,
  scope: McpScope,
  root: string,
  globalDir: string = globalDataDir,
): Result<void> {
  return edit(mcpFile(scope, root, globalDir), (servers) => {
    delete servers[name];
  });
}
