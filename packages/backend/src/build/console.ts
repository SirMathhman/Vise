import { dlopen, FFIType } from "bun:ffi";
import { fstatSync, openSync, writeSync } from "node:fs";

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
      const text = parts.map((p) => (typeof p === "string" ? p : Bun.inspect(p)));
      writeSync(out, `${text.join(" ")}\r\n`);
    };
    console.log = print;
    console.error = print;
  } catch {
    // No terminal to print to.
  }
}
