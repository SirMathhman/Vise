// Hook command loading. Hooks are defined as files in .hooks/<type>/
// directories relative to cwd. Each file's content (trimmed) is a shell
// command to run via powershell. Files are run in alphabetical order.
//
// This module only reads the filesystem; it does not spawn processes or
// print. The loop owns execution, rendering, and conversation seeding.
import * as fs from "node:fs";
import * as path from "node:path";

const HOOKS_DIR = ".hooks";

export type HookCommand = {
  name: string;
  command: string;
  // Optional profile whitelist. If present and non-empty, the hook only
  // runs when the active profile is in this list. If absent, runs for all.
  profiles?: string[];
};

// Parses an optional "# profiles: a,b,c" first line from a hook file.
// Returns { command, profiles } where profiles is undefined if absent.
function parseHookFile(content: string): {
  command: string;
  profiles?: string[];
} {
  const lines = content.split("\n");
  let start = 0;
  let profiles: string[] | undefined;
  const first = lines[0];
  if (first?.trim().startsWith("# profiles:")) {
    const value = first.trim().replace("# profiles:", "").trim();
    profiles = value
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    start = 1;
  }
  const command = lines.slice(start).join("\n").trim();
  return { command, profiles };
}

export function loadHooks(
  type: "pre-session" | "pre-turn" | "post-turn",
): HookCommand[] {
  const dir = path.resolve(process.cwd(), HOOKS_DIR, type);
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .sort();
  const hooks: HookCommand[] = [];
  for (const file of files) {
    const name = file.replace(/\.[^.]+$/, "");
    const raw = fs.readFileSync(path.join(dir, file), "utf-8");
    const { command, profiles } = parseHookFile(raw);
    if (command.length > 0) {
      hooks.push({ name, command, profiles });
    }
  }
  return hooks;
}
