// Prompt, answer, and error rendering. Pure formatting; no fetch.

export function renderPrompt(): void {
  process.stdout.write("you> ");
}

export function renderQuestion(
  question: string,
  type: "freeform" | "multiple_choice" | "multiple_select",
  options?: string[],
): void {
  process.stdout.write(`\nquestion> ${question}\n`);
  if (options) {
    options.forEach((option, index) => {
      process.stdout.write(`  ${index + 1}. ${option}\n`);
    });
    process.stdout.write(
      type === "multiple_select"
        ? "Select any, add your own, or both in a reply.\nanswer> "
        : "Choose one, add your own, or both in a reply.\nanswer> ",
    );
  } else {
    process.stdout.write("answer> ");
  }
}

export function renderToolCallStart(
  name: string,
  args: Record<string, unknown>,
  depth: number,
): void {
  const indent = "  ".repeat(depth);
  const details = Object.entries(args)
    .map(([key, value]) => `${key}=${previewToolArgument(value)}`)
    .join(" ");
  process.stdout.write(
    `\n${indent}tool> ${name}${details ? ` ${details}` : ""}\n`,
  );
}

export function renderToolCallEnd(
  name: string,
  durationMs: number,
  status: "done" | "failed" | "disabled" | "unknown",
  depth: number,
): void {
  const indent = "  ".repeat(depth);
  const seconds = (durationMs / 1000).toFixed(1);
  process.stdout.write(`${indent}tool> ${name} ${status} (${seconds}s)\n`);
}

function previewToolArgument(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "undefined";
  const compact = text.replace(/\s+/g, " ");
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

// Creates a streaming reply handle owned by the transport. The loop
// forwards content deltas to write() as they arrive; the "assistant>" header
// is printed once, lazily, on the first write. end() terminates the reply and
// is idempotent: a second end() or a write() after end() is a no-op, so an
// interrupted reply can't leave the cursor mid-line. If end() is called with
// no prior writes (no deltas arrived, e.g. an empty response), it renders the
// full "(empty response)" placeholder, matching the previous single-shot
// output.
export function createReplyStream(): {
  write: (delta: string) => void;
  end: () => void;
  cancel: () => void;
} {
  let started = false;
  let ended = false;
  return {
    write: (delta: string) => {
      if (ended) return;
      if (!started) {
        process.stdout.write("\nassistant> ");
        started = true;
      }
      process.stdout.write(delta);
    },
    end: () => {
      if (ended) return;
      ended = true;
      if (!started) {
        process.stdout.write("\nassistant> (empty response)");
      }
      // Two newlines: the reply's own terminator plus the blank line the
      // previous renderReply emitted before the next prompt.
      process.stdout.write("\n\n");
    },
    cancel: () => {
      if (ended) return;
      ended = true;
      if (started) process.stdout.write("\n");
    },
  };
}

// Creates a bounded "thinking" indicator for one model completion. The
// model's reasoning can be arbitrarily long, so the indicator never shows
// the reasoning text itself — it repaints a single line with an elapsed-time
// and a running token estimate, then settles into a one-line "thought"
// marker when the answer (or a tool call) begins. All writes are in-place
// (\r repaints), so no matter how long the model thinks, the screen stays
// one line; nothing scrolls. No ANSI codes: plain \r + padding, so it works
// across terminals.
export function createThinkingIndicator(): {
  start: () => void;
  report: (tokens: number) => void;
  finish: () => void;
} {
  let started = false;
  let finished = false;
  let startMs = 0;
  let tokens = 0;
  let lastLength = 0;
  // Paints the current one-line status, clearing any trailing characters left
  // over from a longer previous paint.
  const paint = (done: boolean): void => {
    const elapsed = (Date.now() - startMs) / 1000;
    const line = done
      ? `thought ${elapsed.toFixed(1)}s · ~${tokens} tokens`
      : `thinking… ${elapsed.toFixed(1)}s · ~${tokens} tokens`;
    const pad = " ".repeat(Math.max(0, lastLength - line.length));
    process.stdout.write(`\r${line}${pad}`);
    lastLength = line.length;
  };
  return {
    start: () => {
      if (started || finished) return;
      started = true;
      startMs = Date.now();
      // Drop to a fresh line so the indicator doesn't clobber whatever is on
      // the current line (e.g. the user's prompt line).
      process.stdout.write("\r\n");
      paint(false);
    },
    report: (t: number) => {
      if (!started || finished) return;
      tokens = t;
      paint(false);
    },
    finish: () => {
      if (!started || finished) return;
      finished = true;
      paint(true);
      // A terminating newline so the next thing written (the assistant>
      // header or a prompt) starts on a fresh line.
      process.stdout.write("\n");
    },
  };
}

// Creates a live "prefilling" indicator for one model completion, shown
// while the server reports prefill progress (before any token is generated).
// It mirrors the thinking indicator: repaints a single line in place (\r)
// with an elapsed time and the new-token progress fraction (prefilled-so-far
// over total-new, with the cached count), then settles into a one-line
// "prefilled" summary when thinking or content begins. Plain \r + padding, no
// ANSI codes, so it works across terminals and nothing scrolls. If the
// server doesn't report progress (older builds), start is never called and
// the indicator stays inert.
export function createPrefillIndicator(): {
  start: () => void;
  report: (
    processed: number,
    total: number,
    cache: number,
    timeMs: number,
  ) => void;
  finish: () => void;
} {
  let started = false;
  let finished = false;
  let lastLength = 0;
  let processed = 0;
  let total = 0;
  let cache = 0;
  let timeMs = 0;
  // Paints the current one-line status, clearing any trailing characters left
  // over from a longer previous paint.
  const paint = (done: boolean): void => {
    const newTotal = Math.max(0, total - cache);
    const newDone = Math.max(0, processed - cache);
    const fraction = newTotal > 0 ? `${newDone}/${newTotal}` : `cache ${cache}`;
    const line = done
      ? `prefilled ${(timeMs / 1000).toFixed(2)}s \u00b7 ${fraction}`
      : `prefilling\u2026 ${(timeMs / 1000).toFixed(2)}s \u00b7 ${fraction}`;
    const pad = " ".repeat(Math.max(0, lastLength - line.length));
    process.stdout.write(`\r${line}${pad}`);
    lastLength = line.length;
  };
  return {
    start: () => {
      if (started || finished) return;
      started = true;
      // Drop to a fresh line so the indicator doesn't clobber whatever is on
      // the current line (e.g. the user's prompt line).
      process.stdout.write("\r\n");
    },
    report: (p: number, t: number, c: number, ms: number) => {
      if (finished) return;
      processed = p;
      total = t;
      cache = c;
      timeMs = ms;
      if (!started) return;
      paint(false);
    },
    finish: () => {
      if (!started || finished) return;
      finished = true;
      paint(true);
      // A terminating newline so the next thing written (the assistant>
      // header or a prompt) starts on a fresh line.
      process.stdout.write("\n");
    },
  };
}

export function renderError(message: string): void {
  console.error(`error: ${message}`);
}

export function renderCommand(result: {
  lines: string[];
  isError?: boolean;
}): void {
  const write = result.isError ? console.error : console.log;
  write("");
  for (const line of result.lines) write(line);
  write("");
}

// Prints a notice when the conversation is auto-compacted, so the user can
// tell it happened without having to run /context themselves.
export function renderCompactNotice(): void {
  console.log(
    "\n[compact] conversation summarized to stay under the context window\n",
  );
}

// Renders a labeled hook result. The label identifies which hook produced
// the output (e.g. "pre-session", "lint", "typecheck"). On non-zero exit,
// a warning is printed after the output.
export function renderHook(
  label: string,
  output: string,
  exitCode: number,
): void {
  console.log(`\n${label}:\n${output}\n`);
  if (exitCode !== 0) {
    console.error(`${label}: command exited with code ${exitCode}`);
  }
}
