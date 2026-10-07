import { loadSession, latestSessionId } from "../sessions.ts";
import type { Session } from "../repl/session.ts";
import { historyEntries } from "./history.ts";

export interface ResumeConnection {
  session: Session;
  send: (msg: Record<string, unknown>) => void;
  /** The session's data directory (its saved sessions live there). */
  dataDir: string;
  /** Lines run one after another: the restore goes ahead of whatever the page sends next. */
  chain: Promise<void>;
}

/**
 * A page that opens (or reloads) on a folder picks its conversation up where
 * it was left: the most recently saved session of that folder is restored, for
 * the model and, as a `history` message, for the chat log. Does nothing when
 * the folder has no saved session. Queued first, so the page's own set-up
 * lines run against the restored conversation.
 */
export function queueAutoResume(conn: ResumeConnection): void {
  conn.chain = conn.chain
    .then(async () => {
      const id = latestSessionId(conn.dataDir);
      if (!id) return;
      const saved = loadSession(conn.dataDir, id);
      if (!saved.ok) return;
      const result = await conn.session.handleLine(`/resume ${id}`);
      if (result === "exit" || !result.ok) return;
      conn.send({
        type: "history",
        name: saved.value.name,
        entries: historyEntries(saved.value.messages),
      });
    })
    .catch(() => undefined);
}
