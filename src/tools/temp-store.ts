import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A session's temporary directory, in the operating system's temp folder. A
 * tool result too big to show the model goes in here instead (`spill`), and the
 * model reads or searches the part it needs with the temp tools. The directory
 * is deliberately not persistent: it is removed when the session ends, and
 * leftovers from runs that did not end cleanly are swept on the next start.
 * It exists in every session, including ones with no working directory, which
 * is why these tools are separate from the file tools.
 */

/** More lines than this, or more characters than `MAX_CHARS`, and a result is saved instead of shown. */
export const MAX_LINES = 250;
export const MAX_CHARS = 20_000;

/** How much of a spilled result is still shown inline, so the model knows what it is. */
const PREVIEW_LINES = 40;
const PREVIEW_CHARS = 2_000;

const MAX_MATCHES = 100;
const MAX_MATCH_CHARS = 300;
const STALE_MS = 24 * 60 * 60 * 1000;

/** Temp file names are `<tool>-<n>`: one path-safe segment, never a path. */
const VALID_NAME = /^[\w.-]+$/;

let swept = false;

/** Remove temp directories left by sessions that did not clean up (older than a day). */
function sweepStale(base: string): void {
  if (swept) return;
  swept = true;
  try {
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (Date.now() - statSync(dir).mtimeMs > STALE_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch {
    // no temp area yet, or a file is in use: nothing to sweep
  }
}

const countLines = (text: string): number =>
  text === "" ? 0 : text.split(/\r?\n/).length;

/** Whether a tool result is too big to show the model in full. */
export function isTooLarge(text: string): boolean {
  return text.length > MAX_CHARS || countLines(text) > MAX_LINES;
}

/** The start of `text`: a few lines, and never more than `PREVIEW_CHARS` characters. */
function preview(text: string): string {
  const head = text.split(/\r?\n/).slice(0, PREVIEW_LINES).join("\n");
  return head.length > PREVIEW_CHARS
    ? `${head.slice(0, PREVIEW_CHARS)}...`
    : head;
}

export class TempStore {
  private dir: string | undefined;
  private count = 0;
  /** What each file came from, for `list_temp`. */
  private readonly sources = new Map<string, string>();

  /** `base` is where session folders go; the real temp area unless a test says otherwise. */
  constructor(private readonly base: string = join(tmpdir(), "vise")) {}

  private ensure(): string {
    if (this.dir === undefined) {
      sweepStale(this.base);
      const dir = join(this.base, randomBytes(6).toString("hex"));
      mkdirSync(dir, { recursive: true });
      this.dir = dir;
    }
    return this.dir;
  }

  /** Save a result and return what the model sees instead: its start, its size, and how to read the rest. */
  spill(tool: string, text: string): string {
    const name = `${tool}-${++this.count}`;
    writeFileSync(join(this.ensure(), name), text, "utf8");
    this.sources.set(name, tool);
    return `${preview(text)}\n[... output too large to show: ${countLines(text)} lines, ${text.length} characters. Saved as '${name}'. Read part of it with read_temp (name, offset, limit) or find things in it with search_temp (pattern, name).]`;
  }

  /** The names of the saved files. */
  list(): string[] {
    return [...this.sources.keys()];
  }

  /** The saved file's lines, or an error string. */
  private lines(name: string): string[] | string {
    if (!VALID_NAME.test(name) || !this.sources.has(name)) {
      return `error: no temp file named '${name}'. Saved: ${this.list().join(", ") || "none"}`;
    }
    return readFileSync(join(this.ensure(), name), "utf8").split(/\r?\n/);
  }

  /** `limit` lines of a saved file starting at line `offset` (1-based), with a header and a pointer to the rest. */
  read(name: string, offset: number, limit: number): string {
    const all = this.lines(name);
    if (typeof all === "string") return all;
    const from = Math.max(1, Math.floor(offset));
    const count = Math.min(MAX_LINES, Math.max(1, Math.floor(limit)));
    const slice = all.slice(from - 1, from - 1 + count);
    if (slice.length === 0) {
      return `error: '${name}' has ${all.length} lines; there is nothing at line ${from}`;
    }
    const last = from + slice.length - 1;
    const more =
      last < all.length
        ? `\n[${all.length - last} more lines: continue with offset ${last + 1}]`
        : "";
    return `[${name}: lines ${from}-${last} of ${all.length}]\n${slice.join("\n")}${more}`;
  }

  /** Matching lines of one saved file, or of all of them. */
  search(pattern: string, name?: string, ignoreCase = false): string {
    if (pattern === "") return "error: pattern must not be empty";
    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (err) {
      return `error: invalid pattern (${err instanceof Error ? err.message : String(err)})`;
    }
    const names = name ? [name] : this.list();
    const out: string[] = [];
    let total = 0;
    for (const n of names) {
      const all = this.lines(n);
      if (typeof all === "string") return all;
      all.forEach((line, i) => {
        if (!re.test(line)) return;
        total++;
        if (out.length < MAX_MATCHES) {
          out.push(`${n}:${i + 1}: ${line.slice(0, MAX_MATCH_CHARS)}`);
        }
      });
    }
    if (total === 0) return "no matches";
    const rest = total - out.length;
    return rest > 0
      ? `${out.join("\n")}\n[${rest} more matches: narrow the pattern]`
      : out.join("\n");
  }

  /** `list_temp`: what is saved, with where each came from and how long it is. */
  describe(): string {
    if (this.sources.size === 0) return "no temp files";
    return this.list()
      .map((n) => {
        const lines = this.lines(n);
        const size = typeof lines === "string" ? "?" : lines.length;
        return `${n} — ${size} lines (from ${this.sources.get(n)})`;
      })
      .join("\n");
  }

  /** Delete the session's temp directory. */
  dispose(): void {
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
    this.sources.clear();
  }
}

/** Handlers for the temp tools, over one session's store. */
export function tempHandlers(
  store: TempStore,
): Record<string, (args: Record<string, unknown>) => string> {
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    read_temp: (args) =>
      store.read(
        String(args["name"] ?? ""),
        num(args["offset"], 1),
        num(args["limit"], MAX_LINES),
      ),
    search_temp: (args) =>
      store.search(
        String(args["pattern"] ?? ""),
        args["name"] === undefined ? undefined : String(args["name"]),
        args["ignore_case"] === true,
      ),
    list_temp: () => store.describe(),
  };
}
