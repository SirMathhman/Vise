import type { Database } from "bun:sqlite";

/** One schema step: SQL that takes the database from version N to N + 1. */
export type Migration = string;

/**
 * Bring a database up to date. The schema version is `PRAGMA user_version`;
 * `migrations[i]` takes version i to i + 1, and each runs in a transaction
 * with its version bump, so a crash never leaves a half-applied step.
 */
export function migrate(db: Database, migrations: Migration[]): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < migrations.length; v++) {
    const step = migrations[v];
    if (step === undefined) break;
    db.transaction(() => {
      db.exec(step);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}
