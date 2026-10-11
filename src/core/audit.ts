import type { Message } from "./errors.ts";

/**
 * Something worth keeping in the audit log. Pure data: the edge's sink adds
 * the time and the root, and knows which conversation (`session_start`) and
 * which turn (`turn_start` ... `turn_end`) an event belongs to, because events
 * arrive in the order they happened. `depth` is how deep in subagents it
 * happened (0 for the main agent).
 */
export type AuditEvent =
  | { kind: "session_start"; session: string }
  | { kind: "session_end" }
  /** The conversation is now stored as saved session `saved` (what `/resume` takes). */
  | { kind: "link"; saved: string }
  | { kind: "turn_start"; turn: string; text: string }
  | {
      kind: "turn_end";
      outcome: "ok" | "failed" | "interrupted";
      error?: string;
    }
  | { kind: "message"; message: Message; depth?: number }
  /** A call to the model began (so one that never ends is still on record). */
  | { kind: "model_call_start"; request: number; purpose: string; model: string }
  /** A running call, as far as it has got (written now and then, so a hung call leaves its raw text). */
  | {
      kind: "model_call_progress";
      request: number;
      completionTokens: number;
      raw: string;
      rawReasoning: string;
    }
  /** One call to the model: what it was for, how long it took and what came back. */
  | {
      kind: "model_call";
      purpose: string;
      model: string;
      ms: number;
      promptTokens?: number;
      content?: string;
      reasoning?: string;
      toolCalls?: number;
      error?: string;
      /** The client's number for the call (matches `model_call_start`). */
      request?: number;
      /** What the call wrote, raw: tool calls included, before any was parsed or hidden. */
      raw?: string;
      rawReasoning?: string;
      completionTokens?: number;
      finishReason?: string;
      /** Why it was cut short: `loop`, `token_cap`, `interrupted`, `error`. */
      stopReason?: string;
      loop?: { period: number; repeats: number };
    }
  /** One tool call, with the whole result (before any is saved aside for being large). */
  | {
      kind: "tool_call";
      name: string;
      args: unknown;
      result: string;
      ok: boolean;
      ms: number;
      depth: number;
    }
  | {
      kind: "hook_run";
      phase: "pre" | "post";
      command: string;
      ms: number;
      output: string;
    }
  /** The conversation was cut down: `summarized` messages became `summary` (they are on record as messages). */
  | { kind: "compaction"; summarized: number; kept: number; summary: string }
  | { kind: "goal"; what: "goal" | "verdict" | "setting"; text: string }
  /** A slash command or a notice to the model. */
  | { kind: "event"; name: string; payload: unknown };

/** Where audit events go. Must never throw and must not wait on I/O. */
export interface AuditSink {
  record(event: AuditEvent): void;
}

/** The sink used when nothing is recording. */
export const noAudit: AuditSink = { record: () => undefined };

/** One model call as `/audit calls` and the page's inspector show it. */
export interface AuditCall {
  request: number;
  purpose: string;
  model: string;
  state: "running" | "done" | "stopped" | "error" | "abandoned";
  /** Why it was cut short, when it was. */
  stopReason?: string;
  ms: number;
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
  toolCalls?: number;
  error?: string;
  /** Characters written in all (`raw` may be shortened). */
  rawChars?: number;
  raw?: string;
  reasoning?: string;
  reasoningChars?: number;
  /** What repeats at the end of the call, if anything. */
  loop?: { period: number; repeats: number; sample?: string };
  startedAt?: string;
}

/** What `/audit` can show. */
export type AuditTopic = "summary" | "tools" | "models" | "errors" | "hooks";

/** The answer to an `/audit` question, as data (the edge formats it for the screen). */
export type AuditReport =
  | { topic: "summary"; counts: Record<string, number> }
  | {
      topic: "tools";
      rows: { name: string; calls: number; failures: number; avgMs: number }[];
    }
  | {
      topic: "models";
      rows: {
        purpose: string;
        calls: number;
        errors: number;
        avgMs: number;
        maxPromptTokens: number;
      }[];
    }
  | { topic: "errors"; rows: { what: string; detail: string }[] }
  | {
      topic: "hooks";
      rows: { phase: string; command: string; ms: number; output: string }[];
    }
  | { topic: "calls"; rows: AuditCall[] }
  | { topic: "call"; call?: AuditCall; request: number }
  | {
      topic: "search";
      rows: { kind: string; session: string; snippet: string }[];
    };

/** Read side of the audit log: questions about one conversation, and a search over all of them. */
export interface AuditReader {
  report(session: string, topic: AuditTopic): AuditReport;
  /** The latest `limit` model calls of the conversation, running ones included. */
  calls(session: string, limit: number): AuditReport;
  /** One model call of the conversation, in full. */
  call(session: string, request: number): AuditReport;
  search(text: string): AuditReport;
}
