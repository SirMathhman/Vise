import { z } from "zod";

/** Parsed profile file: frontmatter fields and body. */
export interface ParsedProfile {
  tools?: string[];
  hooks?: string[];
  meta: string[];
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a profile file's frontmatter + body.
 * The frontmatter is a block delimited by `---` lines at the top; inside it,
 * `tools:` is a comma-separated list, `hooks:` is a JSON array of strings,
 * and any other line is opaque meta. The body is everything after the
 * closing `---`.
 */
export function parseProfileText(text: string): ParsedProfile {
  const match = FRONTMATTER.exec(text);
  if (!match) return { meta: [], body: text };
  const meta: string[] = [];
  let tools: string[] | undefined;
  let hooks: string[] | undefined;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const h = /^hooks:\s*(\[.*\])\s*$/.exec(line);
    if (h) {
      try {
        const value: unknown = JSON.parse(h[1] ?? "");
        if (Array.isArray(value) && value.every((c) => typeof c === "string")) {
          hooks = value as string[];
        }
      } catch {
        // not a valid hooks list; treat as meta
      }
      continue;
    }
    const m = /^tools:\s*(.*)$/.exec(line);
    if (m) {
      tools = (m[1] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
    } else {
      meta.push(line);
    }
  }
  return { tools, hooks, meta, body: text.slice(match[0].length) };
}
