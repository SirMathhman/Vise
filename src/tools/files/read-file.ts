import { readFile, stat, writeFile } from "node:fs/promises";
import { err, ok, type Result } from "../../core/messages.ts";
import { MAX_LINES } from "../../core/tools.ts";
import { resolveInside } from "./contain.ts";

// Reads lines `start` to `end` (1-based, inclusive) of a file under `root`. At most
// MAX_LINES lines come back. A longer range is cut short with a line saying where to
// continue, and a range past the end of the file is cut at the last line.
export async function readFileLines(
  root: string,
  path: string,
  start: number,
  end: number,
): Promise<Result<string>> {
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
  if (last < Math.min(end, total))
    notes.push(
      `[truncated at ${MAX_LINES} lines; continue with start=${last + 1}]`,
    );
  if (end > total) notes.push(`[end of file: ${total} lines]`);
  return ok([body, ...notes].join("\n"));
}

// The largest file the page's viewer shows whole. A larger file is refused.
export const MAX_WHOLE_BYTES = 1_000_000;

// Reads a whole file under `root` as text, for the page's file viewer. A file over MAX_WHOLE_BYTES, a
// folder, and a binary file (one with a NUL byte) are refused.
export async function readWholeFile(root: string, path: string): Promise<Result<string>> {
  const inside = await resolveInside(root, path);
  if (!inside.ok) return err(inside.error);
  try {
    const info = await stat(inside.value.realTarget);
    if (!info.isFile()) return err(new Error("not a file"));
    if (info.size > MAX_WHOLE_BYTES)
      return err(new Error(`the file is larger than ${MAX_WHOLE_BYTES} bytes`));
    const bytes = await readFile(inside.value.realTarget);
    if (bytes.includes(0)) return err(new Error("the file is binary"));
    return ok(bytes.toString("utf8"));
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// Writes the whole text of a file under `root`, for the page's editor. The file must exist, be text (no NUL byte),
// and the new text must fit MAX_WHOLE_BYTES, so a page save never turns a text file into a binary one or a big one.
export async function writeWholeText(root: string, path: string, text: string): Promise<Result<void>> {
  const inside = await resolveInside(root, path);
  if (!inside.ok) return err(inside.error);
  if (Buffer.byteLength(text, "utf8") > MAX_WHOLE_BYTES)
    return err(new Error(`the text is larger than ${MAX_WHOLE_BYTES} bytes`));
  try {
    const current = await readFile(inside.value.realTarget);
    if (current.includes(0)) return err(new Error("the file is binary"));
    await writeFile(inside.value.realTarget, text, "utf8");
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
