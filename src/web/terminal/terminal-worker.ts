// The ConPTY read loop, run on its own worker thread.
//
// A blocking ReadFile on the ConPTY output pipe would stall the main thread's
// event loop, so (as with the desktop window in window-worker.ts) the read
// runs on its own thread. This worker owns all ConPTY FFI I/O for one shell:
// it spawns powershell.exe under a pseudo console, streams output chunks back,
// relays keystrokes, resizes, and closes. The main-thread TerminalSession
// (terminal.ts) is a thin message-passing layer over this worker, so the FFI
// handles never cross threads.
//
// Windows-only: `spawnPty` throws on other platforms.

import {
  spawnPty, writePtyInput, readPtyOutput, resizePty, closePty, isPtyExited,
  getPtyExitCode, type PtyHandle,
} from "./conpty.ts";

declare const self: Worker;

interface InMessage {
  type: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  data?: string; // base64 UTF-8 keystrokes for `write`
}

let handle: PtyHandle | null = null;
let reading = false;

/** Pump the output pipe until the process exits or we are told to stop. */
function startReading(): void {
  if (reading) return;
  reading = true;
  const pump = (): void => {
    const h = handle;
    if (!h) { reading = false; return; }
    const chunk = readPtyOutput(h);
    if (chunk.length > 0) {
      // Send as a base64 string so bytes survive JSON over the socket.
      self.postMessage({ type: "data", data: Buffer.from(chunk).toString("base64") });
      pump(); // more may be immediately available; keep draining this tick.
      return;
    }
    if (isPtyExited(h)) {
      reading = false;
      self.postMessage({ type: "exit", code: getPtyExitCode(h) });
      return;
    }
    // No data and the child is still running: yield and retry on the next tick.
    setTimeout(pump, 1);
  };
  pump();
}

self.onmessage = (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "spawn": {
      if (handle) return; // already open; ignore duplicate
      handle = spawnPty(msg.cols ?? 80, msg.rows ?? 24, msg.cwd);
      self.postMessage({ type: "ready", pid: handle.pid });
      startReading();
      return;
    }
    case "write": {
      if (handle && msg.data) writePtyInput(handle, Buffer.from(msg.data, "base64").toString("utf8"));
      return;
    }
    case "resize": {
      if (handle) resizePty(handle, msg.cols ?? 80, msg.rows ?? 24);
      return;
    }
    case "close": {
      if (handle) { closePty(handle); handle = null; }
      reading = false;
      return;
    }
  }
};
