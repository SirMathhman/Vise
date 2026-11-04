import { readFile } from "node:fs/promises";
import { err, ok, type Result } from "../core/result.ts";
import { MAX_LINES } from "../core/tools.ts";
import { resolveInside } from "./contain.ts";

// Reads lines `start` to `end` (1-based, inclusive) of a file under `root`. At most
// MAX_LINES lines come back. A longer range is cut short with a line saying where to
// continue, and a range past the end of the file is cut at the last line.
export async function readFileLines(root: string, path: string, start: number, end: number): Promise<Result<string>> {
  const inside = await resolveInside(root, path);
  if (!inside.ok) return err(inside.error);
  let text: string;
  try {
    text = await readFile(inside.value.realTarget, "utf8");
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const total = lines.length;
  if (start > total) return ok(`[the file has ${total} lines]`);
  const last = Math.min(end, total, start + MAX_LINES - 1);
  const body = lines
    .slice(start - 1, last)
    .map((line) => line.replace(/\r$/, ""))
    .join("\n");
  const notes: string[] = [];
  if (last < Math.min(end, total)) notes.push(`[truncated at ${MAX_LINES} lines; continue with start=${last + 1}]`);
  if (end > total) notes.push(`[end of file: ${total} lines]`);
  return ok([body, ...notes].join("\n"));
}
