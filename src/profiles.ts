// Profile registry. A profile is a named set of custom system instructions
// (like a custom agent persona). Profiles come from two sources:
//   1. The built-in "agent" profile (the default; its instruction is the
//      AGENTS.md instructions plus the CWD system message).
//   2. File-based profiles from `.agents/*.md` in the working directory.
//      The filename (minus extension) is the profile name; the file content
//      is the system instruction.
//
// Every profile's instruction is composed from the AGENTS.md instructions
// (when present) plus the profile's own instruction, so the model receives
// the codebase's agent instructions in the system prompt regardless of which
// profile is active.
//
// No mutable state. Pure functions over the filesystem.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

export type Profile = {
  name: string;
  instruction: string;
  source: "builtin" | "file";
  tools?: string[];
};

const AGENTS_DIR = ".agents";
const AGENTS_MD = "AGENTS.md";

// Reads AGENTS.md from the working directory once at startup and returns its
// trimmed content, or null if the file is missing or unreadable. The value
// is computed once (at module load) and reused, so edits to AGENTS.md during
// a session are not picked up.
function loadAgentsMd(): string | null {
  try {
    const filePath = path.resolve(process.cwd(), AGENTS_MD);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
    const content = readFileSync(filePath, "utf-8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

const AGENTS_MD_CONTENT = loadAgentsMd();

// Composes a profile's system instruction from the AGENTS.md instructions
// (when present) plus the profile's own instruction. Returns the bare
// instruction when AGENTS.md is absent.
function composeInstruction(instruction: string): string {
  if (AGENTS_MD_CONTENT === null) return instruction;
  return `You are a custom agent.\nHere are the instructions for this codebase:\n\n${AGENTS_MD_CONTENT}\n\n${instruction}`;
}

// The built-in default profile. Its instruction is the AGENTS.md instructions
// plus the CWD message that seeds the conversation at startup. No tool
// whitelist: all tools are available.
export const BUILTIN_AGENT: Profile = {
  name: "agent",
  instruction: composeInstruction(
    `The current working directory is: ${process.cwd()}`,
  ),
  source: "builtin",
};

// Parses a profile file's content into instruction + optional tool whitelist.
// A line starting with "tools:" (case-insensitive) declares the whitelist as
// a comma-separated list of tool names. That line is removed from the
// instruction. If no such line exists, tools is undefined (all tools allowed).
function parseProfileContent(content: string): {
  instruction: string;
  tools?: string[];
} {
  const lines = content.split("\n");
  const instructionLines: string[] = [];
  let toolNames: string[] | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith("tools:")) {
      const value = trimmed.slice("tools:".length).trim();
      if (value.length > 0) {
        toolNames = value.split(/,|\s+/).filter((n) => n.length > 0);
      }
    } else {
      instructionLines.push(line);
    }
  }
  const instruction = instructionLines.join("\n").trim();
  return { instruction, tools: toolNames };
}

// Returns every available profile: the built-in agent plus any .agents/*.md
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
      const { instruction, tools } = parseProfileContent(content);
      profiles.push({
        name,
        instruction: composeInstruction(instruction),
        source: "file",
        tools,
      });
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
    const { instruction, tools } = parseProfileContent(content);
    return {
      name,
      instruction: composeInstruction(instruction),
      source: "file",
      tools,
    };
  } catch {
    return undefined;
  }
}

// Creates a new profile file with a minimal stub. Returns an error message
// string if the profile already exists or the file cannot be written;
// returns null on success.
export function createProfile(name: string): string | null {
  if (name.length === 0) return "profile name is required";
  if (getProfile(name) !== undefined) return `profile already exists: ${name}`;
  const dirPath = path.resolve(process.cwd(), AGENTS_DIR);
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  const filePath = path.join(dirPath, `${name}.md`);
  const template = `# Profile: ${name}\nYou are a ${name} agent. Edit this instruction to describe your role and behavior.\n`;
  try {
    writeFileSync(filePath, template, "utf-8");
    return null;
  } catch (err) {
    return `could not create profile file: ${err instanceof Error ? err.message : String(err)}`;
  }
}
