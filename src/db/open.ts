import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrate, type Migration } from "./migrate.ts";

/**
 * Process-wide SQLite connections, one per database file. SQLite allows one
 * writer, and several web connections on the same root share one file, so they
 * must share one connection too. Edge I/O (invariant #2): `bun:sqlite` is
 * imported only under `src/db/`.
 */
const open = new Map<string, Database>();

/** Open (or reuse) the database at `path`, creating it and applying `migrations`. */
export function openDb(path: string, migrations: Migration[]): Database {
  const key = path === ":memory:" ? path : resolve(path);
  const cached = open.get(key);
  if (cached) return cached;
  if (key !== ":memory:") mkdirSync(dirname(key), { recursive: true });
  const db = new Database(key, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, migrations);
  open.set(key, db);
  return db;
}

/** Close every connection (tests on Windows cannot delete an open database file). */
export function closeAllDbs(): void {
  for (const db of open.values()) db.close();
  open.clear();
}
