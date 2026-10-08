import type { Message } from "./errors.ts";

/**
 * Something worth keeping in the audit log. Pure data: the edge's sink adds
 * the time and the root, and decides where it goes. Ids are made by the
 * session (`session` is one conversation, `turn` one user message).
 */
export type AuditEvent =
  | { kind: "session_start"; session: string }
  | { kind: "session_end"; session: string }
  /** The conversation is now stored as saved session `saved` (what `/resume` takes). */
  | { kind: "link"; session: string; saved: string }
  | { kind: "turn_start"; session: string; turn: string; text: string }
  | {
      kind: "turn_end";
      turn: string;
      outcome: "ok" | "failed" | "interrupted";
      error?: string;
    }
  | { kind: "message"; session: string; turn?: string; message: Message }
  /** Anything else: a slash command, a notice to the model, a switch... `payload` is JSON-able. */
  | {
      kind: "event";
      session: string;
      turn?: string;
      name: string;
      payload: unknown;
    };

/** Where audit events go. Must never throw and must not wait on I/O. */
export interface AuditSink {
  record(event: AuditEvent): void;
}

/** The sink used when nothing is recording. */
export const noAudit: AuditSink = { record: () => undefined };
