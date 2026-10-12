// One shell under a pseudo console, as a small event-style object.
// The ConPTY calls that do not block run here on the main thread; the blocking
// read of its output runs on a reader thread (pty-reader-worker.ts).

import { VERSION } from "@vise/backend";
import {
  closeOutput,
  closePty,
  exitCodeOf,
  resizePty,
  spawnPty,
  writePty,
  type SpawnOptions,
} from "./conpty.ts";

/** A running shell. Implemented over ConPTY here; tests use a fake. */
export interface PtyProcess {
  readonly pid: number;
  /** Send keystrokes (text as typed, including control characters). */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Stop the shell; `onExit` still follows. Idempotent. */
  kill(): void;
  onData(listener: (text: string) => void): void;
  /** Called once, after the last output, with the exit code. */
  onExit(listener: (code: number) => void): void;
}

export type SpawnPty = (options: Required<SpawnOptions>) => PtyProcess;

const EXIT_POLL_MS = 250;

function readerWorker(): Worker {
  // Bun embeds a worker only when the compiled build names it as a plain literal, relative to the folder
  // the entry points share (src/web, see scripts/build-exe.ts); from source the path is relative to this file.
  if (VERSION !== "dev") return new Worker("./terminal/pty-reader-worker.ts");
  return new Worker(new URL("./pty-reader-worker.ts", import.meta.url));
}

/** Start a shell under ConPTY. Throws when it cannot be started (or off Windows). */
export const spawnConPty: SpawnPty = (options) => {
  const handle = spawnPty(options);
  const decoder = new TextDecoder();
  let onData: (text: string) => void = () => {};
  let onExit: (code: number) => void = () => {};
  let closed = false;
  let exitCode: number | null = null;
  let readerDone = false;
  let reported = false;

  const report = (): void => {
    if (reported || !readerDone) return;
    reported = true;
    clearInterval(poll);
    void reader.terminate();
    onExit(exitCode ?? 1);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    // Closing the console ends the output pipe, so the reader drains what is left and stops.
    closePty(handle);
  };

  const reader = readerWorker();
  reader.onmessage = (event: MessageEvent<{ type: string; bytes?: ArrayBuffer }>) => {
    if (event.data.type === "data" && event.data.bytes) {
      const text = decoder.decode(new Uint8Array(event.data.bytes), { stream: true });
      if (text) onData(text);
      return;
    }
    const rest = decoder.decode();
    if (rest) onData(rest);
    closeOutput(handle.output);
    readerDone = true;
    close();
    report();
  };
  reader.onerror = () => {
    readerDone = true;
    close();
    report();
  };
  reader.postMessage({ output: handle.output });

  // The output pipe stays open while the console does, so the shell's own exit is noticed here.
  const poll = setInterval(() => {
    if (closed) return;
    const code = exitCodeOf(handle);
    if (code === null) return;
    exitCode = code;
    close();
  }, EXIT_POLL_MS);

  return {
    pid: handle.pid,
    write: (data) => {
      if (!closed) writePty(handle, data);
    },
    resize: (cols, rows) => {
      if (!closed) resizePty(handle, cols, rows);
    },
    kill: close,
    onData: (listener) => (onData = listener),
    onExit: (listener) => (onExit = listener),
  };
};
