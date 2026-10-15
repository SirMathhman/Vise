import type { CallLog } from "@vise/backend";

/** How often a subscribed page is sent the call it is watching (ms). */
const PUSH_MS = 250;
/** How much of the raw text a push carries (characters). */
const TAIL_CHARS = 6000;

type Send = (msg: Record<string, unknown>) => void;

/**
 * The page's live look at a model call: while the page is subscribed
 * (`inspect_start`), the call it names (or the newest running one, or the last
 * to finish) is pushed as `call_raw` a few times a second, with the end of
 * what it has written, so a long hidden "Writing…" can be read as it happens.
 * Handled at once, never queued behind a turn.
 */
export function createInspector(calls: CallLog, send: Send) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let watching: number | undefined;
  let lastSent = "";

  const push = (): void => {
    const trace =
      watching !== undefined ? calls.get(watching) : (calls.current() ?? calls.traces()[0]);
    if (!trace) {
      const empty = JSON.stringify({ none: true });
      if (empty !== lastSent) send({ type: "call_raw", none: true });
      lastSent = empty;
      return;
    }
    const snapshot = trace.snapshot(false);
    const seconds = Math.max(0.001, snapshot.ms / 1000);
    const message = {
      type: "call_raw",
      request: snapshot.request,
      purpose: snapshot.purpose,
      model: snapshot.model,
      state: snapshot.state,
      stopReason: snapshot.stopReason,
      detail: snapshot.error,
      ms: snapshot.ms,
      promptTokens: snapshot.promptTokens,
      tokens: snapshot.completionTokens,
      tokensPerSec: snapshot.completionTokens
        ? Math.round((snapshot.completionTokens / seconds) * 10) / 10
        : 0,
      chars: snapshot.rawChars,
      tail: trace.rawTail(TAIL_CHARS),
      reasoning: trace.reasoningTail(TAIL_CHARS),
      loop: snapshot.loop,
      finishReason: snapshot.finishReason,
      recent: calls
        .traces()
        .slice(0, 12)
        .map((t) => ({
          request: t.request,
          purpose: t.purpose,
          state: t.state,
          stopReason: t.stopReason,
          tokens: t.completionTokens,
          ms: Math.round(t.ms),
        })),
    };
    // A finished call that has already been sent in its final form is not sent again.
    const key = JSON.stringify([
      message.request,
      message.state,
      message.tokens,
      message.chars,
      message.stopReason,
    ]);
    if (trace.state !== "running" && key === lastSent) return;
    lastSent = key;
    send(message);
  };

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  return {
    /** Handle an inspector message; false when it is not one. */
    handle(msg: { type: string; request?: number }): boolean {
      if (msg.type === "inspect_start") {
        watching = typeof msg.request === "number" ? msg.request : undefined;
        lastSent = "";
        stop();
        push();
        timer = setInterval(push, PUSH_MS);
        return true;
      }
      if (msg.type === "inspect_stop") {
        stop();
        return true;
      }
      return false;
    },
    /** The connection closed. */
    dispose: stop,
  };
}
