import type { Database } from "bun:sqlite";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Message } from "../../core/errors.ts";
import { writeSession } from "./session-write.ts";

/**
 * One-time import of the old `sessions/<uuid>.json` files into the database.
 * Each file is imported in its own transaction, checked (the stored message
 * count must equal the file's), and only then deleted. A file that is not
 * valid is left where it is; one whose id already has a row (an import that
 * stopped before the delete) is just removed, the database copy being newer.
 * Returns a line for each file that was kept.
 */
export function importLegacySessions(db: Database, base: string): string[] {
  const skipped: string[] = [];
  const dir = join(base, "sessions");
  if (!existsSync(dir)) return skipped;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    if (!/^[0-9a-f-]{1,36}$/.test(id)) continue;
    try {
      importOne(db, join(dir, file), id);
    } catch (e) {
      skipped.push(`${file}: ${String(e)}`);
    }
  }
  try {
    rmdirSync(dir); // only succeeds when empty
  } catch {
    // files were kept; leave the directory
  }
  return skipped;
}

function importOne(db: Database, path: string, id: string): void {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
    string,
    unknown
  >;
  if (!Array.isArray(raw.messages)) throw new Error("no messages array");
  const messages = raw.messages as Message[];
  const exists = db.query("SELECT 1 FROM sessions WHERE id = ?").get(id);
  if (!exists) {
    const name =
      typeof raw.name === "string" && raw.name.trim() ? raw.name : id;
    const profile =
      typeof raw.activeProfile === "string" ? raw.activeProfile : undefined;
    const savedAt =
      typeof raw.savedAt === "string" && raw.savedAt
        ? raw.savedAt
        : new Date().toISOString();
    writeSession(db, id, name, messages, profile, savedAt);
    const row = db
      .query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
      .get(id) as { n: number };
    if (row.n !== messages.length) throw new Error("message count mismatch");
  }
  unlinkSync(path);
}
