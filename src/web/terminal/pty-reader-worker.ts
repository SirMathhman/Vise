// The blocking read of one shell's output pipe, on its own thread.
//
// ReadFile blocks until the shell writes or the pipe closes, which would stall
// the server's event loop, so (as with the desktop window) it runs here. This
// thread only reads: it never receives another message after the first, because
// it never returns to its event loop. Writing, resizing and closing happen on
// the main thread (pty.ts); a kernel handle is valid in every thread of the process.

import { readPty } from "./conpty.ts";

declare const self: Worker;

const CHUNK = 16 * 1024;

self.onmessage = (event: MessageEvent<{ output: number }>) => {
  const { output } = event.data;
  for (;;) {
    const buffer = new Uint8Array(CHUNK);
    const n = readPty(output, buffer);
    if (n === 0) break;
    const bytes = buffer.buffer.slice(0, n);
    self.postMessage({ type: "data", bytes }, [bytes]);
  }
  self.postMessage({ type: "end" });
};
