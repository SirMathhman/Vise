import { config } from "../../config.ts";
import type { AuditCall, AuditSink } from "@vise/core";
import type { AssistantMessage, Result, ViseError } from "@vise/core";
import { WINDOW_CHARS, findLoop, repetition, runawayVerdict } from "@vise/core";
import { formatError } from "../../output/format.ts";
import type { GenerationListener } from "./stream-reader.ts";

/** Raw text kept for one call: its start, then a rolling tail (a 100k-token runaway stays bounded). */
const HEAD_CHARS = 64_000;
const TAIL_CHARS = 192_000;
/** Reasoning kept: the end of it. */
const REASONING_CHARS = 64_000;
/** Finished calls remembered for the inspector and `/audit`. */
const FINISHED_KEPT = 50;

export type CallState = "running" | "done" | "stopped" | "error";

/**
 * Everything one model call produced as it streamed, kept as it happens: the
 * raw text (tool calls included, before any of it is hidden or parsed), the
 * reasoning, the server's token count, why it ended. The audit log and the
 * page's inspector read it, so a call that never ends can still be looked at.
 */
export class CallTrace {
  private head = "";
  private tail = "";
  private total = 0;
  private thought = "";
  private thoughtTotal = 0;
  state: CallState = "running";
  stopReason?: string;
  finishReason?: string;
  completionTokens = 0;
  promptTokens?: number;
  toolCalls?: number;
  error?: string;
  private endedAt?: number;

  constructor(
    readonly request: number,
    readonly purpose: string,
    readonly model: string,
    private readonly startedMs: number = Date.now(),
    private readonly clock: () => number = Date.now,
  ) {}

  text(piece: string): void {
    this.total += piece.length;
    let rest = piece;
    if (this.head.length < HEAD_CHARS) {
      const room = HEAD_CHARS - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest === "") return;
    this.tail = (this.tail + rest).slice(-TAIL_CHARS);
  }

  reasoning(piece: string): void {
    this.thoughtTotal += piece.length;
    this.thought = (this.thought + piece).slice(-REASONING_CHARS);
  }

  tokens(count: number): void {
    this.completionTokens = count;
  }

  /** Mark the call over (`stopReason` says why when it was cut short). */
  end(state: Exclude<CallState, "running">, stopReason?: string): void {
    if (this.state !== "running") return;
    this.state = state;
    this.stopReason = stopReason;
    this.endedAt = this.clock();
  }

  /** How many characters were written in all (calls included). */
  get chars(): number {
    return this.total;
  }

  /** The end of the raw text (at most `max` characters), for the loop check and the inspector. */
  rawTail(max: number = WINDOW_CHARS): string {
    const tail = this.tail === "" ? this.head : this.tail;
    return tail.slice(-max);
  }

  /** The end of the reasoning. */
  reasoningTail(max: number = WINDOW_CHARS): string {
    return this.thought.slice(-max);
  }

  /** All of the raw text kept: its start, a note of what was left out, then the rolling tail. */
  raw(): string {
    const left = this.total - this.head.length - this.tail.length;
    const gap = left > 0 ? `\n[… ${left} characters left out …]\n` : "";
    return this.head + gap + this.tail;
  }

  /** What repeats at the end of the call's text (or reasoning), if anything. */
  loop(): AuditCall["loop"] {
    const found = findLoop(this.rawTail()) ?? repetition(this.reasoningTail());
    return found
      ? { period: found.period, repeats: found.repeats, sample: found.sample }
      : undefined;
  }

  get ms(): number {
    return (this.endedAt ?? this.clock()) - this.startedMs;
  }

  /** The call as plain data (`full` adds the whole kept raw text). */
  snapshot(full = true): AuditCall {
    return {
      request: this.request,
      purpose: this.purpose,
      model: this.model,
      state: this.state,
      stopReason: this.stopReason,
      ms: Math.round(this.ms),
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      finishReason: this.finishReason,
      toolCalls: this.toolCalls,
      error: this.error,
      rawChars: this.total,
      raw: full ? this.raw() : this.rawTail(6000),
      reasoning: full ? this.thought : this.reasoningTail(2000),
      reasoningChars: this.thoughtTotal,
      loop: this.loop(),
      startedAt: new Date(this.startedMs).toISOString(),
    };
  }
}

/** The calls of one client: those running, and the last few that finished. */
export class CallLog {
  private readonly running = new Map<number, CallTrace>();
  private finished: CallTrace[] = [];

  start(trace: CallTrace): CallTrace {
    this.running.set(trace.request, trace);
    return trace;
  }

  finish(trace: CallTrace): void {
    this.running.delete(trace.request);
    this.finished.push(trace);
    if (this.finished.length > FINISHED_KEPT) this.finished.shift();
  }

  /** Running calls first, then finished ones, newest first. */
  traces(): CallTrace[] {
    return [...this.running.values(), ...[...this.finished].reverse()];
  }

  get(request: number): CallTrace | undefined {
    return (
      this.running.get(request) ??
      this.finished.find((t) => t.request === request)
    );
  }

  /** The newest running call, if any. */
  current(): CallTrace | undefined {
    return [...this.running.values()].at(-1);
  }
}

/** A running call is judged (loop, token cap) every this many generated tokens. */
const CHECK_EVERY = 50;
/** A running call's raw text so far goes to the audit log this often (ms). */
const CHECKPOINT_MS = 30_000;
/** The end of a call's reasoning kept in the audit log. */
const REASONING_RECORDED = 20_000;

/**
 * What a streaming call's text and token count are fed to: its trace, and
 * the page's generation reporter (`inner`). Every `CHECK_EVERY` tokens the call
 * is judged, and a runaway one is aborted through `guard`.
 */
export function traceListener(
  trace: CallTrace,
  inner: GenerationListener | undefined,
  guard: AbortController,
): GenerationListener {
  let checkedAt = 0;
  // Whether the server reports its own running token count (llama.cpp's
  // `timings`). Other providers may send none, so each streamed piece
  // is counted as one token and the guard still runs.
  let reported = false;
  let pieces = 0;
  const judge = (tokens: number): void => {
    const loopGuard = config.loopGuard !== 0;
    const cap = config.maxCallTokens;
    let verdict = runawayVerdict({
      tokens,
      cap,
      tail: trace.rawTail(),
      loopGuard,
      sentences: true,
    });
    if (!verdict.stop) {
      verdict = runawayVerdict({
        tokens: 0,
        cap: 0,
        tail: trace.reasoningTail(),
        loopGuard,
      });
    }
    if (!verdict.stop || trace.state !== "running") return;
    trace.error = verdict.detail;
    trace.end("stopped", verdict.reason);
    guard.abort();
  };
  return {
    text(piece) {
      trace.text(piece);
      inner?.text(piece);
      if (reported) return;
      pieces += 1;
      if (pieces - checkedAt < CHECK_EVERY) return;
      checkedAt = pieces;
      trace.tokens(pieces);
      judge(pieces);
    },
    tokens(count) {
      reported = true;
      trace.tokens(count);
      inner?.tokens(count);
      if (count - checkedAt < CHECK_EVERY) return;
      checkedAt = count;
      judge(count);
    },
    finish(reason) {
      trace.finishReason = reason;
    },
  };
}

/** The error for a call the guard stopped (or the server cut at the cap); undefined for any other call. */
export function runawayError(trace: CallTrace | undefined): ViseError | undefined {
  if (trace?.state !== "stopped") return undefined;
  if (trace.stopReason !== "loop" && trace.stopReason !== "token_cap") {
    return undefined;
  }
  return {
    kind: "runaway",
    reason: trace.stopReason,
    detail: trace.error ?? "it ran away",
    tokens: trace.completionTokens,
    purpose: trace.purpose,
  };
}

/**
 * Put a call on record when it starts, and keep its raw text so far on record
 * while it runs (so a call that hangs, or a program that dies, still leaves
 * it). Returns what to call when the call ends.
 */
export function recordCallStart(sink: AuditSink, trace: CallTrace): () => void {
  const { request, purpose, model } = trace;
  sink.record({ kind: "model_call_start", request, purpose, model });
  const checkpoint = setInterval(() => {
    sink.record({
      kind: "model_call_progress",
      request,
      completionTokens: trace.completionTokens,
      raw: trace.raw(),
      rawReasoning: trace.reasoningTail(REASONING_RECORDED),
    });
  }, CHECKPOINT_MS);
  checkpoint.unref?.();
  return () => clearInterval(checkpoint);
}

/** Close a call's trace from how it came out, and put its record in the audit log. */
export function recordCallEnd(
  sink: AuditSink,
  trace: CallTrace,
  result: Result<AssistantMessage>,
  promptTokens: number | undefined,
): void {
  const reply = result.ok ? result.value : undefined;
  trace.promptTokens = result.ok ? promptTokens : undefined;
  trace.toolCalls = reply?.tool_calls?.length;
  const failure = result.ok ? undefined : formatError(result.error);
  if (failure !== undefined && trace.error === undefined) trace.error = failure;
  if (result.ok) trace.end("done");
  else if (result.error.kind === "interrupted") trace.end("stopped", "interrupted");
  else trace.end("error", "error");
  const loop = trace.loop();
  sink.record({
    kind: "model_call",
    purpose: trace.purpose,
    model: trace.model,
    ms: trace.ms,
    promptTokens: trace.promptTokens,
    content: reply?.content,
    reasoning: reply?.reasoning,
    toolCalls: trace.toolCalls,
    error: failure,
    request: trace.request,
    raw: trace.raw(),
    rawReasoning: trace.reasoningTail(REASONING_RECORDED),
    completionTokens: trace.completionTokens,
    finishReason: trace.finishReason,
    stopReason: trace.stopReason,
    loop: loop ? { period: loop.period, repeats: loop.repeats } : undefined,
  });
}

/** The reasoning of a call, noted in its trace before it goes on to `onThinking`. */
export function traceThinking(
  trace: CallTrace,
  next: ((token: string) => void) | undefined,
): (token: string) => void {
  return (token) => {
    trace.reasoning(token);
    next?.(token);
  };
}

/** The server cutting a call at `max_tokens` (`finish_reason: length`) counts as a runaway too; returns the trace. */
export function noteServerCut(trace: CallTrace | undefined): CallTrace | undefined {
  if (trace?.state === "running" && trace.finishReason === "length" && config.maxCallTokens > 0) {
    trace.error = `the server stopped it at the ${config.maxCallTokens}-token limit`;
    trace.end("stopped", "token_cap");
  }
  return trace;
}
