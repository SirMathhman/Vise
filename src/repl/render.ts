// Prompt, answer, and error rendering. Pure formatting; no fetch.
export function renderPrompt(): void {
  process.stdout.write("you> ");
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
