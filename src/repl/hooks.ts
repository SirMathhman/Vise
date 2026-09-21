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
};

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
    const command = fs.readFileSync(path.join(dir, file), "utf-8").trim();
    if (command.length > 0) {
      hooks.push({ name, command });
    }
  }
  return hooks;
}
