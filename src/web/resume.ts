import { loadSession, latestSessionId } from "../sessions.ts";
import type { Session } from "../repl/session.ts";
import { historyEntries } from "./history.ts";
import type { SessionLease } from "./leases.ts";

export interface ResumeConnection {
  session: Session;
  send: (msg: Record<string, unknown>) => void;
  /** The session's data directory (its saved sessions live there). */
  dataDir: string;
  /** Lines run one after another: the restore goes ahead of whatever the page sends next. */
  chain: Promise<void>;
  /** Which saved sessions this connection may continue (see `SessionLease`). */
  lease: SessionLease;
}

/**
 * A page that opens (or reloads) on a folder picks its conversation up where
 * it was left: the most recently saved session of that folder is restored, for
 * the model and, as a `history` message, for the chat log. Does nothing when
 * the folder has no saved session, and starts blank (with a note) when another
 * tab already has that session open. Queued first, so the page's own set-up
 * lines run against the restored conversation.
 */
export function queueAutoResume(conn: ResumeConnection): void {
  conn.chain = conn.chain
    .then(async () => {
      const latest = latestSessionId(conn.dataDir);
      if (!latest.ok || !latest.value) return;
      const id = latest.value;
      const saved = loadSession(conn.dataDir, id);
      if (!saved.ok) return;
      if (!conn.lease.claim(id)) {
        conn.send({
          type: "history",
          name: "",
          entries: [
            {
              kind: "note",
              text: "The last session is open in another tab, so this one starts fresh (/resume lists the saved sessions).",
            },
          ],
        });
        return;
      }
      const result = await conn.session.handleLine(`/resume ${id}`);
      if (result === "exit" || !result.ok) {
        conn.lease.release();
        return;
      }
      conn.send({
        type: "history",
        name: saved.value.name,
        entries: historyEntries(saved.value.messages),
      });
    })
    .catch(() => undefined);
}
