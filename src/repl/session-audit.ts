import { noAudit, type AuditSink } from "../core/audit.ts";
import type { Message, Result, ViseError } from "../core/errors.ts";
import { formatError } from "../output/format.ts";

/**
 * The session's side of the audit log: ids for the conversation and the turn
 * in flight, and which messages have already been recorded. The engine
 * mutates the conversation array in place, so messages are picked up by
 * position (`messages`) at the points where the session looks at the array.
 */
export class SessionAudit {
  private session = crypto.randomUUID();
  private turn: string | undefined;
  private recorded = 0;
  private linked: string | undefined;
  private outcome: "ok" | "failed" | "interrupted" = "failed";
  private failure: string | undefined;

  constructor(private readonly sink: AuditSink = noAudit) {
    this.sink.record({ kind: "session_start", session: this.session });
  }

  /** Record the messages added since the last call. */
  messages(all: Message[]): void {
    for (const message of all.slice(this.recorded)) {
      this.sink.record({
        kind: "message",
        session: this.session,
        turn: this.turn,
        message,
      });
    }
    this.recorded = all.length;
  }

  /** The conversation was replaced by one already on record (resume, compaction): do not record its messages again. */
  skip(length: number): void {
    this.recorded = length;
  }

  turnStart(text: string): void {
    this.turn = crypto.randomUUID();
    this.outcome = "failed";
    this.failure = "the turn ended without a result";
    this.sink.record({
      kind: "turn_start",
      session: this.session,
      turn: this.turn,
      text,
    });
  }

  /** How the turn in flight ended, from the engine's result (`turnEnd` writes it). */
  turnResult(result: Result<unknown>): void {
    this.outcome = result.ok ? "ok" : outcomeOf(result.error);
    this.failure = result.ok ? undefined : formatError(result.error);
  }

  /** The turn is over; `saved` is the id the conversation is saved under, if it has one. */
  turnEnd(saved?: string): void {
    if (saved !== undefined) this.link(saved);
    if (this.turn === undefined) return;
    this.sink.record({
      kind: "turn_end",
      turn: this.turn,
      outcome: this.outcome,
      error: this.failure,
    });
    this.turn = undefined;
  }

  /** Run a slash command (already started, or finished), noting it, and record the messages it added once it is done. */
  async command<T>(
    line: string,
    running: T | Promise<T>,
    messages: () => Message[],
  ): Promise<T> {
    this.event("command", { line });
    try {
      return await running;
    } finally {
      this.messages(messages());
    }
  }

  event(name: string, payload: unknown): void {
    this.sink.record({
      kind: "event",
      session: this.session,
      turn: this.turn,
      name,
      payload,
    });
  }

  /** The conversation is now saved under `saved`; says so once per id. */
  link(saved: string): void {
    if (saved === this.linked) return;
    this.linked = saved;
    this.sink.record({ kind: "link", session: this.session, saved });
  }

  /** End this conversation's record (`/new`, or the session closing). */
  end(): void {
    this.sink.record({ kind: "session_end", session: this.session });
  }

  /** End this conversation's record and start a new one. */
  restart(all: Message[]): void {
    this.messages(all);
    this.end();
    this.session = crypto.randomUUID();
    this.turn = undefined;
    this.recorded = 0;
    this.linked = undefined;
    this.sink.record({ kind: "session_start", session: this.session });
  }
}

function outcomeOf(error: ViseError): "failed" | "interrupted" {
  return error.kind === "interrupted" ? "interrupted" : "failed";
}
