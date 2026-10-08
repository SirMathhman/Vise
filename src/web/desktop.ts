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
      GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
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
        const text = parts.map((p) => (typeof p === "string" ? p : Bun.inspect(p))).join(" ");
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

/** Open the app window on `url`; `onClosed` runs when the user closes it. Returns a function that closes it. */
export function openWindow(url: string, onClosed: () => void): () => void {
  // Bun embeds a worker only when the compiled build names it as a plain literal; from source the path is relative to this file.
  let worker: Worker;
  if (VERSION !== "dev") worker = new Worker("./window-worker.ts");
  else worker = new Worker(new URL("./window-worker.ts", import.meta.url));
  worker.onmessage = () => onClosed();
  worker.onerror = (event) => console.error("window failed:", event.message);
  worker.postMessage({ url });
  return () => void worker.terminate();
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
      writeSync(out, `${parts.map((p) => (typeof p === "string" ? p : Bun.inspect(p))).join(" ")}
`);
    };
    console.log = print;
    console.error = print;
  } catch {
    // No terminal to print to.
  }
}
