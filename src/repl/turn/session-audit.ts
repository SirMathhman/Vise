import {
  noAudit,
  type AuditReader,
  type AuditSink,
  type AuditTopic,
} from "../../core/audit.ts";
import type { GoalEvent } from "./goal-loop.ts";
import type { Message, Result, ViseError } from "../../core/errors.ts";
import { formatAuditReport } from "../../output/audit-format.ts";
import { formatError } from "../../output/format.ts";

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

  constructor(
    readonly sink: AuditSink = noAudit,
    private readonly reader?: AuditReader,
  ) {
    this.sink.record({ kind: "session_start", session: this.session });
  }

  /** Record the messages added since the last call. */
  messages(all: Message[]): void {
    for (const message of all.slice(this.recorded)) {
      this.sink.record({ kind: "message", message });
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
    this.sink.record({ kind: "turn_start", turn: this.turn, text });
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
      outcome: this.outcome,
      error: this.failure,
    });
    this.turn = undefined;
  }

  /** The turn ended by an exception rather than a result. */
  turnThrew(error: unknown): void {
    this.outcome = "failed";
    this.failure = String(error);
  }

  /** The goal tracker said something (the goal, a verdict, the setting). */
  goal(event: GoalEvent): void {
    const text =
      event.kind === "goal"
        ? `${event.goal} (done when: ${event.doneWhen})`
        : event.kind === "verdict"
          ? `${event.verdict}: ${event.detail}`
          : event.enabled
            ? "on"
            : "off";
    this.sink.record({ kind: "goal", what: event.kind, text });
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
    this.sink.record({ kind: "event", name, payload });
  }

  /** The conversation is now saved under `saved`; says so once per id. */
  link(saved: string): void {
    if (saved === this.linked) return;
    this.linked = saved;
    this.sink.record({ kind: "link", saved });
  }

  /** End this conversation's record (`/new`, or the session closing). */
  end(): void {
    this.sink.record({ kind: "session_end" });
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

  /** Whether `/audit` has a log to read. */
  get enabled(): boolean {
    return this.reader !== undefined;
  }

  /** `/audit [tools|models|errors|hooks]` and `/audit search <text>`; undefined when `line` is not an audit command. */
  slash(line: string): Result<string> | undefined {
    if (line !== "/audit" && !line.startsWith("/audit ")) return undefined;
    const arg = line.slice("/audit".length).trim();
    const fail = (body: string): Result<string> => ({
      ok: false,
      error: { kind: "malformed", body },
    });
    if (!this.reader) return fail("the audit log is off (VISE_AUDIT=0)");
    const topic = arg === "" ? "summary" : arg;
    try {
      if (arg === "search" || arg.startsWith("search ")) {
        const text = arg.slice("search".length).trim();
        if (text === "") return fail("usage: /audit search <text>");
        return { ok: true, value: formatAuditReport(this.reader.search(text)) };
      }
      if (arg === "calls" || arg.startsWith("calls ")) {
        const limit = Number(arg.slice("calls".length).trim() || 20);
        if (!Number.isInteger(limit) || limit < 1) return fail("usage: /audit calls [n]");
        return { ok: true, value: formatAuditReport(this.reader.calls(this.session, limit)) };
      }
      if (arg === "call" || arg.startsWith("call ")) {
        const request = Number(arg.slice("call".length).trim());
        if (!Number.isInteger(request) || request < 1) return fail("usage: /audit call <n>  (n is the # of /audit calls)");
        return { ok: true, value: formatAuditReport(this.reader.call(this.session, request)) };
      }
      if (!TOPICS.includes(topic as AuditTopic)) {
        return fail(
          `usage: /audit [${TOPICS.join("|")}|calls [n]|call <n>] or /audit search <text>`,
        );
      }
      const report = this.reader.report(this.session, topic as AuditTopic);
      return { ok: true, value: formatAuditReport(report) };
    } catch (e) {
      return fail(`could not read the audit log: ${String(e)}`);
    }
  }
}

const TOPICS: AuditTopic[] = ["summary", "tools", "models", "errors", "hooks"];

function outcomeOf(error: ViseError): "failed" | "interrupted" {
  return error.kind === "interrupted" ? "interrupted" : "failed";
}
