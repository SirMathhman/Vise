// ConPTY (Windows pseudo console) FFI primitives over kernel32.dll via bun:ffi.
// Windows-only: throws a clear error on other platforms.
//
// Follows the bun:ffi pattern in src/web/desktop/desktop.ts (main-thread dlopen
// of kernel32.dll) and src/web/desktop/window-worker.ts (wide-string helpers).
//
// This module holds only the low-level operations (spawnPty, writePtyInput,
// readPtyOutput, resizePty, closePty, isPtyExited, getPtyExitCode). The blocking
// read loop that keeps a ConPTY alive runs on its own worker thread (see
// terminal-worker.ts), because a blocking ReadFile would stall the main thread's
// event loop — the same reason the desktop window runs on its own worker.

import { dlopen, FFIType, ptr } from "bun:ffi";

// ─── Windows constants ────────────────────────────────────────────────────

const STARTF_USESTDHANDLES = 0x100;
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 12;
const STILL_ACTIVE = 259;

// ─── Struct helpers ───────────────────────────────────────────────────────

/** A wide string (UTF-16LE) terminated by a NUL char, for FFI. */
function wPtr(s: string): number {
  return ptr(Buffer.from(`${s}\0`, "utf16le"));
}

/** COORD: two int16 values (4 bytes). */
function makeCoord(cols: number, rows: number): number {
  const buf = new ArrayBuffer(4);
  new Int16Array(buf)[0] = cols;
  new Int16Array(buf)[1] = rows;
  return ptr(buf);
}

/** SECURITY_ATTRIBUTES: { Length; lpSecurityDescriptor; bInheritHandle; } (24 bytes on 64-bit). */
function makeSecurityAttributes(): number {
  const buf = new ArrayBuffer(24);
  new Uint32Array(buf, 0, 1)[0] = 24; // Length
  new Int32Array(buf, 16, 1)[0] = 0; // bInheritHandle = FALSE
  return ptr(buf);
}

/**
 * STARTUPINFOEXW (144 bytes on 64-bit). We set only cb, dwFlags, dwAttributeSize
 * and lpAttributeList; the rest is zero.
 */
function makeStartupInfoEx(attrPtr: number, attrSize: number): number {
  const buf = new ArrayBuffer(144);
  const u32 = new Uint32Array(buf);
  const u64 = new BigUint64Array(buf);
  u32[0] = 144; // cb (offset 0)
  u32[10] = STARTF_USESTDHANDLES; // dwFlags (offset 40)
  u32[20] = attrSize; // dwAttributeSize (offset 80)
  u64[11] = BigInt(attrPtr); // lpAttributeList (offset 88)
  return ptr(buf);
}

/**
 * One PROC_THREAD_ATTRIBUTES entry for the pseudo console (96 bytes on 64-bit).
 */
function makeProcThreadAttr(handle: number): number {
  const buf = new ArrayBuffer(96);
  const u32 = new Uint32Array(buf);
  const u64 = new BigUint64Array(buf);
  u32[0] = 96; // Size
  u32[1] = PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE; // Attribute
  u64[2] = BigInt(handle); // AttrPtr (offset 24)
  u32[7] = 8; // ValueSize = 8 (offset 32)
  return ptr(buf);
}

// ─── FFI loading ──────────────────────────────────────────────────────────

let kernel32: ReturnType<typeof dlopen> | null = null;

function getKernel32() {
  if (!kernel32) {
    kernel32 = dlopen("kernel32.dll", {
      CreatePipe: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.bool,
      },
      CreatePseudoConsole: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32, FFIType.ptr],
        returns: FFIType.u32,
      },
      ResizePseudoConsole: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.u32,
      },
      ClosePseudoConsole: {
        args: [FFIType.i32],
        returns: FFIType.u32,
      },
      CreateProcessW: {
        args: [
          FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,
          FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr,
          FFIType.ptr, FFIType.ptr,
        ],
        returns: FFIType.bool,
      },
      ReadFile: {
        args: [
          FFIType.i32, FFIType.ptr, FFIType.u32,
          FFIType.ptr, FFIType.ptr, FFIType.ptr,
        ],
        returns: FFIType.bool,
      },
      WriteFile: {
        args: [
          FFIType.i32, FFIType.ptr, FFIType.u32,
          FFIType.ptr, FFIType.ptr, FFIType.ptr,
        ],
        returns: FFIType.bool,
      },
      CloseHandle: {
        args: [FFIType.i32],
        returns: FFIType.bool,
      },
      TerminateProcess: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.bool,
      },
      WaitForSingleObject: {
        args: [FFIType.i32, FFIType.u32],
        returns: FFIType.u32,
      },
      GetExitCodeProcess: {
        args: [FFIType.i32, FFIType.ptr],
        returns: FFIType.bool,
      },
    });
  }
  return kernel32;
}

// ─── Public types ─────────────────────────────────────────────────────────

export interface PtyHandle {
  /** The pseudo console handle. */
  ptyHandle: number;
  /** The child process handle. */
  processHandle: number;
  /** The child's output pipe (read from this to get output). */
  outputHandle: number;
  /** The child's input pipe (write to this to send keystrokes). */
  inputHandle: number;
  /** The child's process ID. */
  pid: number;
  /** Whether this handle has been closed. */
  closed: boolean;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Spawn powershell.exe under a ConPTY pseudo console.
 * @param cols initial console width in columns
 * @param rows initial console height in rows
 * @param cwd working directory for the shell
 * @returns a PtyHandle for I/O and lifecycle management
 */
export function spawnPty(
  cols: number,
  rows: number,
  cwd?: string,
): PtyHandle {
  if (process.platform !== "win32") {
    throw new Error(
      "interactive terminal is Windows-only (ConPTY); run on Windows to use it",
    );
  }

  const k = getKernel32();
  const secAttr = makeSecurityAttributes();

  // Input pipe: we write the write end (hInput); ConPTY reads the read end.
  const inRead = new Int32Array(1);
  const inWrite = new Int32Array(1);
  if (!k.symbols.CreatePipe(ptr(inRead), ptr(inWrite), secAttr, 0)) {
    throw new Error("CreatePipe failed (input)");
  }
  const hInput = inWrite[0];
  const hPtyInput = inRead[0];

  // Output pipe: we read the read end (hOutput); ConPTY writes the write end.
  const outRead = new Int32Array(1);
  const outWrite = new Int32Array(1);
  if (!k.symbols.CreatePipe(ptr(outRead), ptr(outWrite), secAttr, 0)) {
    throw new Error("CreatePipe failed (output)");
  }
  const hOutput = outRead[0];
  const hPtyOutput = outWrite[0];

  // CreatePseudoConsole(dwSize, hPtyInput, hPtyOutput, dwFlags, phPty).
  const hPty = new Int32Array(1);
  if (!k.symbols.CreatePseudoConsole(makeCoord(cols, rows), hPtyInput, hPtyOutput, 0, ptr(hPty))) {
    throw new Error("CreatePseudoConsole failed");
  }
  const ptyHandle = hPty[0];

  // The ConPTY owns the two ends it was given; drop our copies.
  k.symbols.CloseHandle(hPtyInput);
  k.symbols.CloseHandle(hPtyOutput);

  // Create the process with the pseudo console as its std handles.
  const startup = makeStartupInfoEx(makeProcThreadAttr(ptyHandle), 96);
  const procInfo = new ArrayBuffer(24); // PROCESS_INFORMATION (24 bytes on 64-bit)
  const ok = k.symbols.CreateProcessW(
    null,                         // lpApplicationName
    wPtr("powershell.exe"),       // lpCommandLine
    null,                         // lpProcessAttributes
    null,                         // lpThreadAttributes
    0,                            // bInheritHandles = FALSE
    CREATE_NEW_PROCESS_GROUP,     // dwCreationFlags
    null,                         // lpEnvironment
    cwd ? wPtr(cwd) : null,       // lpCurrentDirectory
    startup,                      // lpStartupInfo
    procInfo,                     // lpProcessInformation
  );
  if (!ok) throw new Error("CreateProcessW failed");

  const processHandle = Number(new BigUint64Array(procInfo)[0]);
  const pid = new Uint32Array(procInfo, 16)[0]; // dwProcessId

  return { ptyHandle, processHandle, inputHandle: hInput, outputHandle: hOutput, pid, closed: false };
}

/**
 * Write UTF-8 keystrokes to the ConPTY input pipe. ConPTY expects UTF-16LE, so
 * we re-encode the incoming UTF-8 string.
 */
export function writePtyInput(handle: PtyHandle, utf8: string): void {
  if (handle.closed) return;
  const k = getKernel32();
  const utf16 = Buffer.from(utf8, "utf16le");
  const written = new Int32Array(1);
  k.symbols.WriteFile(handle.inputHandle, ptr(utf16), utf16.length, ptr(written), null, null);
}

/**
 * Resize the ConPTY console to the given dimensions.
 */
export function resizePty(handle: PtyHandle, cols: number, rows: number): void {
  if (handle.closed) return;
  const k = getKernel32();
  k.symbols.ResizePseudoConsole(handle.ptyHandle, makeCoord(cols, rows));
}

/**
 * Read available output from the ConPTY output pipe. Blocks until data is
 * available or the pipe is closed (returns an empty array on EOF, which means
 * the child exited). Intended to run on a worker thread, not the main one.
 */
export function readPtyOutput(handle: PtyHandle, bufSize = 4096): Uint8Array {
  if (handle.closed) return new Uint8Array(0);
  const k = getKernel32();
  const buf = new Uint8Array(bufSize);
  const bytesRead = new Int32Array(1);
  k.symbols.ReadFile(handle.outputHandle, ptr(buf), bufSize, ptr(bytesRead), null, null);
  const n = bytesRead[0];
  return n > 0 ? buf.slice(0, n) : new Uint8Array(0);
}

/**
 * Close the ConPTY and terminate the child process. Idempotent.
 */
export function closePty(handle: PtyHandle): void {
  if (handle.closed) return;
  handle.closed = true;
  const k = getKernel32();
  k.symbols.ClosePseudoConsole(handle.ptyHandle);
  k.symbols.TerminateProcess(handle.processHandle, 1);
  k.symbols.CloseHandle(handle.processHandle);
  k.symbols.CloseHandle(handle.inputHandle);
  k.symbols.CloseHandle(handle.outputHandle);
}

/**
 * True once the child process has exited (or the handle is already closed).
 */
export function isPtyExited(handle: PtyHandle): boolean {
  if (handle.closed) return true;
  const k = getKernel32();
  return k.symbols.WaitForSingleObject(handle.processHandle, 0) === STILL_ACTIVE ? false : true;
}

/**
 * The exit code of a ConPTY child that has exited. -1 if unavailable.
 */
export function getPtyExitCode(handle: PtyHandle): number {
  const k = getKernel32();
  const exitCode = new Uint32Array(1);
  k.symbols.GetExitCodeProcess(handle.processHandle, ptr(exitCode));
  return exitCode[0] === STILL_ACTIVE ? -1 : exitCode[0];
}
