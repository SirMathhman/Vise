// ConPTY (Windows pseudo console) primitives over kernel32.dll via bun:ffi.
// Windows-only: `spawnPty` throws a clear error on other platforms.
//
// Every HANDLE/HPCON is pointer-sized: out-parameters are read through a
// BigUint64Array and passed back as numbers. Buffers handed to `ptr()` are kept
// in locals until the call returns so the collector cannot free them early.
// The blocking read of the output pipe runs on its own thread (pty-reader-worker.ts);
// spawning, writing, resizing and closing do not block and run on the caller's.

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const EXTENDED_STARTUPINFO_PRESENT = 0x0008_0000;
const CREATE_SUSPENDED = 0x0000_0004;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x0002_0016;
const STARTUPINFOEXW_SIZE = 112; // STARTUPINFOW (104) + lpAttributeList
const STARTF_USESTDHANDLES = 0x100;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
const WAIT_OBJECT_0 = 0;
const STILL_ACTIVE = 259;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE = 144;

const H = FFIType.ptr; // a HANDLE / HPCON / pointer argument

const SYMBOLS = {
  CreatePipe: { args: [H, H, H, FFIType.u32], returns: FFIType.bool },
  CreatePseudoConsole: {
    args: [FFIType.u32, H, H, FFIType.u32, H],
    returns: FFIType.i32,
  },
  ResizePseudoConsole: { args: [H, FFIType.u32], returns: FFIType.i32 },
  ClosePseudoConsole: { args: [H], returns: FFIType.void },
  InitializeProcThreadAttributeList: {
    args: [H, FFIType.u32, FFIType.u32, H],
    returns: FFIType.bool,
  },
  UpdateProcThreadAttribute: {
    args: [H, FFIType.u32, FFIType.u64, H, FFIType.u64, H, H],
    returns: FFIType.bool,
  },
  DeleteProcThreadAttributeList: { args: [H], returns: FFIType.void },
  CreateProcessW: {
    args: [H, H, H, H, FFIType.bool, FFIType.u32, H, H, H, H],
    returns: FFIType.bool,
  },
  ResumeThread: { args: [H], returns: FFIType.u32 },
  CreateJobObjectW: { args: [H, H], returns: H },
  SetInformationJobObject: {
    args: [H, FFIType.u32, H, FFIType.u32],
    returns: FFIType.bool,
  },
  AssignProcessToJobObject: { args: [H, H], returns: FFIType.bool },
  ReadFile: { args: [H, H, FFIType.u32, H, H], returns: FFIType.bool },
  WriteFile: { args: [H, H, FFIType.u32, H, H], returns: FFIType.bool },
  CloseHandle: { args: [H], returns: FFIType.bool },
  TerminateProcess: { args: [H, FFIType.u32], returns: FFIType.bool },
  WaitForSingleObject: { args: [H, FFIType.u32], returns: FFIType.u32 },
  GetExitCodeProcess: { args: [H, H], returns: FFIType.bool },
  GetLastError: { args: [], returns: FFIType.u32 },
} as const;

let kernel32: ReturnType<typeof dlopen<typeof SYMBOLS>>["symbols"] | null = null;

function k32(): NonNullable<typeof kernel32> {
  kernel32 ??= dlopen("kernel32.dll", SYMBOLS).symbols;
  return kernel32;
}

/** A handle as an FFI argument (handles are kept as plain numbers here). */
const h = (value: number): Pointer => value as Pointer;

/** Read one pointer-sized out-parameter. */
const out = (cell: BigUint64Array): number => Number(cell[0] ?? 0n);

/** COORD passed by value: X (columns) in the low word, Y (rows) in the high word. */
const coord = (cols: number, rows: number): number => ((rows & 0xffff) << 16) | (cols & 0xffff);

function fail(what: string): never {
  throw new Error(`${what} failed (Windows error ${k32().GetLastError()})`);
}

/**
 * One job object for every shell this process starts, closed only when the
 * process ends: then Windows kills the shells too, even after a crash.
 */
let job = 0;

function jobObject(): number {
  if (job) return job;
  const k = k32();
  const handle = Number(k.CreateJobObjectW(null, null) ?? 0);
  if (!handle) return 0;
  const info = new ArrayBuffer(JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE);
  new Uint32Array(info, 16, 1)[0] = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; // BasicLimitInformation.LimitFlags
  k.SetInformationJobObject(
    h(handle),
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
    ptr(info),
    info.byteLength,
  );
  job = handle;
  return job;
}

export interface PtyHandle {
  /** The pseudo console. */
  readonly console: number;
  /** The child process. */
  readonly process: number;
  /** Our end of the input pipe: keystrokes go here. */
  readonly input: number;
  /** Our end of the output pipe: the reader thread reads it. */
  readonly output: number;
  readonly pid: number;
}

export interface SpawnOptions {
  /** The command line, e.g. `powershell.exe -NoLogo`. */
  command: string;
  cwd?: string;
  cols: number;
  rows: number;
}

function createPipe(): { read: number; write: number } {
  const read = new BigUint64Array(1);
  const write = new BigUint64Array(1);
  if (!k32().CreatePipe(ptr(read), ptr(write), null, 0)) fail("CreatePipe");
  return { read: out(read), write: out(write) };
}

/** A thread attribute list that attaches the child to the pseudo console. */
function attributeList(console: number): Uint8Array {
  const k = k32();
  const size = new BigUint64Array(1);
  k.InitializeProcThreadAttributeList(null, 1, 0, ptr(size)); // fails by design: reports the size
  const list = new Uint8Array(Number(size[0] ?? 0n));
  if (!k.InitializeProcThreadAttributeList(ptr(list), 1, 0, ptr(size)))
    fail("InitializeProcThreadAttributeList");
  // For the pseudo console the value is the HPCON itself, not a pointer to it.
  if (
    !k.UpdateProcThreadAttribute(
      ptr(list),
      0,
      PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
      h(console),
      8,
      null,
      null,
    )
  )
    fail("UpdateProcThreadAttribute");
  return list;
}

/** Start `command` attached to a new pseudo console of `cols` x `rows`. */
export function spawnPty(options: SpawnOptions): PtyHandle {
  if (process.platform !== "win32")
    throw new Error("the integrated terminal is Windows-only (ConPTY)");
  const k = k32();
  const input = createPipe(); // we write input.write; the console reads input.read
  const output = createPipe(); // the console writes output.write; we read output.read
  const hpc = new BigUint64Array(1);
  const hr = k.CreatePseudoConsole(
    coord(options.cols, options.rows),
    h(input.read),
    h(output.write),
    0,
    ptr(hpc),
  );
  // The console holds its own copies of the ends it was given.
  k.CloseHandle(h(input.read));
  k.CloseHandle(h(output.write));
  if (hr !== 0) {
    k.CloseHandle(h(input.write));
    k.CloseHandle(h(output.read));
    throw new Error(`CreatePseudoConsole failed (HRESULT ${hr >>> 0})`);
  }
  const console = out(hpc);
  const list = attributeList(console);
  const startup = new ArrayBuffer(STARTUPINFOEXW_SIZE);
  new Uint32Array(startup, 0, 1)[0] = STARTUPINFOEXW_SIZE; // cb
  // Without this a child of a process whose own std handles are redirected (a
  // pipe, a log file) writes there instead of to the pseudo console.
  new Uint32Array(startup, 60, 1)[0] = STARTF_USESTDHANDLES; // dwFlags
  new BigUint64Array(startup, 80, 3).fill(INVALID_HANDLE_VALUE); // hStdInput/Output/Error
  new BigUint64Array(startup, 104, 1)[0] = BigInt(ptr(list)); // lpAttributeList
  const info = new ArrayBuffer(24); // PROCESS_INFORMATION
  const commandLine = Buffer.from(`${options.command}\0`, "utf16le"); // writable, as CreateProcessW requires
  const cwd = options.cwd ? Buffer.from(`${options.cwd}\0`, "utf16le") : null;
  const ok = k.CreateProcessW(
    null,
    ptr(commandLine),
    null,
    null,
    false,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
    null,
    cwd ? ptr(cwd) : null,
    ptr(startup),
    ptr(info),
  );
  k.DeleteProcThreadAttributeList(ptr(list));
  if (!ok) {
    const error = k.GetLastError();
    k.ClosePseudoConsole(h(console));
    k.CloseHandle(h(input.write));
    k.CloseHandle(h(output.read));
    throw new Error(`could not start "${options.command}" (Windows error ${error})`);
  }
  const handles = new BigUint64Array(info, 0, 2);
  const processHandle = Number(handles[0] ?? 0n);
  const thread = Number(handles[1] ?? 0n);
  const pid = new Uint32Array(info, 16, 1)[0] ?? 0;
  // Join the job before the shell runs, so anything it starts is in it too.
  const jobHandle = jobObject();
  if (jobHandle) k.AssignProcessToJobObject(h(jobHandle), h(processHandle));
  k.ResumeThread(h(thread));
  k.CloseHandle(h(thread));
  return {
    console,
    process: processHandle,
    input: input.write,
    output: output.read,
    pid,
  };
}

/** Send keystrokes: ConPTY reads UTF-8 input. */
export function writePty(handle: PtyHandle, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length === 0) return;
  const written = new Uint32Array(1);
  k32().WriteFile(h(handle.input), ptr(bytes), bytes.length, ptr(written), null);
}

export function resizePty(handle: PtyHandle, cols: number, rows: number): void {
  k32().ResizePseudoConsole(h(handle.console), coord(cols, rows));
}

/**
 * Block until output arrives, then return it; an empty array means the pipe
 * closed (the pseudo console was closed). Only for the reader thread.
 */
export function readPty(output: number, buffer: Uint8Array): number {
  const read = new Uint32Array(1);
  const ok = k32().ReadFile(h(output), ptr(buffer), buffer.length, ptr(read), null);
  return ok ? (read[0] ?? 0) : 0;
}

/** The exit code once the child has ended, or null while it runs. */
export function exitCodeOf(handle: PtyHandle): number | null {
  const k = k32();
  if (k.WaitForSingleObject(h(handle.process), 0) !== WAIT_OBJECT_0) return null;
  const code = new Uint32Array(1);
  k.GetExitCodeProcess(h(handle.process), ptr(code));
  const value = code[0] ?? STILL_ACTIVE;
  return value === STILL_ACTIVE ? null : value;
}

/**
 * Close the pseudo console (which ends the reader's pipe), stop the child if
 * it still runs, and release every handle but the output pipe, which the
 * reader closes when it is done with it.
 */
export function closePty(handle: PtyHandle): void {
  const k = k32();
  k.ClosePseudoConsole(h(handle.console));
  k.TerminateProcess(h(handle.process), 1);
  k.CloseHandle(h(handle.process));
  k.CloseHandle(h(handle.input));
}

/** Release the output pipe once the reader has seen its end. */
export function closeOutput(output: number): void {
  k32().CloseHandle(h(output));
}
