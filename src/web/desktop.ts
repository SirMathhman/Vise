import { dlopen, FFIType, ptr } from "bun:ffi";
import { appendFileSync, fstatSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { globalDataDir } from "../data-dir.ts";
import { VERSION } from "../version.ts";

/** Where the desktop build writes what it would print: its console is hidden. */
export const logPath = join(globalDataDir, "vise.log");

/**
 * Whether to open Vise's own window. A compiled build does, unless
 * `--no-window` (then it only serves, for a browser); from source, only with
 * `--window`.
 */
export function windowMode(argv: string[] = process.argv): boolean {
  if (argv.includes("--window")) return true;
  return VERSION !== "dev" && !argv.includes("--no-window");
}

/**
 * Hide the console window when this process alone owns it (it was started by
 * a double-click). A terminal the user launched Vise from is shared with other
 * processes and is left alone.
 */
export function hideOwnConsole(): void {
  if (process.platform !== "win32") return;
  try {
    const { symbols } = dlopen("kernel32.dll", {
      GetConsoleProcessList: {
        args: [FFIType.ptr, FFIType.u32],
        returns: FFIType.u32,
      },
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
    });
    const user32 = dlopen("user32.dll", {
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    const owners = symbols.GetConsoleProcessList(ptr(new Uint32Array(2)), 2);
    const window = symbols.GetConsoleWindow();
    if (owners === 1 && window) user32.symbols.ShowWindow(window, 0);
  } catch {
    // A console that stays visible is better than a start-up failure.
  }
}

/** Send console output to the log file (nobody sees a hidden console). */
export function logToFile(path: string = logPath): void {
  const write =
    (level: string) =>
    (...parts: unknown[]): void => {
      try {
        const text = parts
          .map((p) => (typeof p === "string" ? p : Bun.inspect(p)))
          .join(" ");
        appendFileSync(path, `${new Date().toISOString()} ${level} ${text}\n`);
      } catch {
        // Logging must never break the program.
      }
    };
  console.log = write("info");
  console.info = write("info");
  console.warn = write("warn");
  console.error = write("error");
}

/** What the window thread reports (see `window-worker.ts`). */
export type WindowEvent =
  { type: "ready" } | { type: "closed" } | { type: "failed"; reason: string };

/** The event a message from the window thread stands for; anything unexpected is a failure. */
export function parseWindowEvent(data: unknown): WindowEvent {
  const event = data as { type?: unknown; reason?: unknown } | null;
  if (event?.type === "ready" || event?.type === "closed") {
    return { type: event.type };
  }
  if (event?.type === "failed" && typeof event.reason === "string") {
    return { type: "failed", reason: event.reason };
  }
  return { type: "failed", reason: "the window reported something unexpected" };
}

/** How long the window gets to appear before it counts as failed. */
const START_TIMEOUT_MS = 10_000;

/**
 * Open the app window on `url` and report what happens to it: `ready` once it
 * is up, `closed` when the user closes it, `failed` if it cannot start,
 * crashes or does not appear in time. Returns a function that ends the window thread.
 */
export function openWindow(
  url: string,
  onEvent: (event: WindowEvent) => void,
): () => void {
  // Bun embeds a worker only when the compiled build names it as a plain literal; from source the path is relative to this file.
  let worker: Worker;
  if (VERSION !== "dev") worker = new Worker("./window-worker.ts");
  else worker = new Worker(new URL("./window-worker.ts", import.meta.url));
  const watchdog = setTimeout(
    () =>
      onEvent({
        type: "failed",
        reason: "the window did not appear within 10 seconds",
      }),
    START_TIMEOUT_MS,
  );
  const report = (event: WindowEvent): void => {
    clearTimeout(watchdog);
    onEvent(event);
  };
  worker.onmessage = (message) => report(parseWindowEvent(message.data));
  worker.onerror = (event) => report({ type: "failed", reason: event.message });
  worker.onmessageerror = () =>
    report({
      type: "failed",
      reason: "the window thread sent an unreadable message",
    });
  worker.postMessage({ url });
  return () => {
    clearTimeout(watchdog);
    void worker.terminate();
  };
}

/** Tell the user something with a native message box (nobody sees a hidden console). */
export function showError(title: string, text: string): void {
  if (process.platform !== "win32") return;
  try {
    const { symbols } = dlopen("user32.dll", {
      MessageBoxW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
    });
    const wide = (s: string) => ptr(Buffer.from(`${s}\0`, "utf16le"));
    symbols.MessageBoxW(null, wide(text), wide(title), 0x10);
  } catch {
    // The reason is in the log either way.
  }
}

/**
 * The desktop exe has no console of its own, so a maintenance flag (`--version`
 * ...) would print nowhere: attach to the terminal that started it and print
 * there. Does nothing useful when there is no such terminal.
 */
export function useParentConsole(): void {
  if (process.platform !== "win32") return;
  try {
    // Output already goes somewhere (a redirect or a pipe): leave it be.
    fstatSync(1);
    return;
  } catch {
    // No standard output: look for a terminal.
  }
  try {
    const { symbols } = dlopen("kernel32.dll", {
      AttachConsole: { args: [FFIType.u32], returns: FFIType.bool },
    });
    if (!symbols.AttachConsole(0xffffffff)) return;
    const out = openSync("CONOUT$", "w");
    const print = (...parts: unknown[]): void => {
      const text = parts.map((p) =>
        typeof p === "string" ? p : Bun.inspect(p),
      );
      writeSync(out, `${text.join(" ")}\r\n`);
    };
    console.log = print;
    console.error = print;
  } catch {
    // No terminal to print to.
  }
}
