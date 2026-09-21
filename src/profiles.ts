// Profile registry. A profile is a named set of custom system instructions
// (like a custom agent persona). Profiles come from two sources:
//   1. The built-in "Agent" profile (the default; its instruction is the
//      CWD system message).
//   2. File-based profiles from `.agents/*.md` in the working directory.
//      The filename (minus extension) is the profile name; the file content
//      is the system instruction.
//
// No mutable state. Pure functions over the filesystem.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

export type Profile = {
  name: string;
  instruction: string;
  source: "builtin" | "file";
};

const AGENTS_DIR = ".agents";

// The built-in default profile. Its instruction is the CWD message that seeds
// the conversation at startup.
export const BUILTIN_AGENT: Profile = {
  name: "Agent",
  instruction: `The current working directory is: ${process.cwd()}`,
  source: "builtin",
};

// Returns every available profile: the built-in Agent plus any .agents/*.md
// files found in the working directory.
export function listProfiles(): Profile[] {
  const profiles: Profile[] = [BUILTIN_AGENT];
  const dirPath = path.resolve(process.cwd(), AGENTS_DIR);
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return profiles;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const name = entry.name.replace(/\.md$/, "");
    if (name.length === 0) continue;
    if (name === BUILTIN_AGENT.name) continue; // file can't shadow the built-in
    try {
      const content = readFileSync(
        path.join(dirPath, entry.name),
        "utf-8",
      ).trim();
      if (content.length === 0) continue;
      profiles.push({ name, instruction: content, source: "file" });
    } catch {
      // unreadable file: skip
    }
  }
  return profiles;
}

// Looks up a profile by exact name. Returns undefined if not found.
export function getProfile(name: string): Profile | undefined {
  if (name === BUILTIN_AGENT.name) return BUILTIN_AGENT;
  const filePath = path.resolve(process.cwd(), AGENTS_DIR, `${name}.md`);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return undefined;
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (content.length === 0) return undefined;
    return { name, instruction: content, source: "file" };
  } catch {
    return undefined;
  }
}
