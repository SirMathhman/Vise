import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Which browser engine the integrated browser uses (server-wide, chosen in the web UI). */
export type BrowserEngine = "chromium" | "firefox";

export interface BrowserSettings {
  engine: BrowserEngine;
  /** Firefox only: attach to a Firefox started with `--remote-debugging-port`; absent: launch one. */
  firefoxPort?: number;
}

export const DEFAULT_SETTINGS: BrowserSettings = { engine: "chromium" };

/**
 * Validate untrusted settings (a file, or a message from the page): an unknown
 * engine means Chromium, and a port that is not an integer in 1-65535 is
 * dropped. Returns an error string for a port that was given but is invalid.
 */
export function parseSettings(raw: unknown): BrowserSettings | string {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const engine: BrowserEngine =
    r["engine"] === "firefox" ? "firefox" : "chromium";
  const port = r["firefoxPort"];
  if (port === undefined || port === null || port === "") return { engine };
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return "the Firefox port must be a whole number from 1 to 65535";
  }
  return engine === "firefox" ? { engine, firefoxPort: n } : { engine };
}

/** The global browser settings file (not per project: one browser is shared by every session). */
export class BrowserSettingsStore {
  constructor(
    private readonly file: string = join(homedir(), ".vise", "browser.json"),
  ) {}

  load(): BrowserSettings {
    try {
      const parsed = parseSettings(JSON.parse(readFileSync(this.file, "utf8")));
      return typeof parsed === "string" ? DEFAULT_SETTINGS : parsed;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  /** Write atomically (temp file + rename) so a crash cannot leave half a file. */
  save(settings: BrowserSettings): string | null {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(settings, null, 2));
      renameSync(temp, this.file);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
