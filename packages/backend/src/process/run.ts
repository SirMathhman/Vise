import type { Result } from "common";
import { err, ok } from "common";

/**
 * The most output one command returns, per stream and in total.
 */
export const MAX_CHARS = 20_000;

// Environment names that look like credentials are not passed on to a spawned program.
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

// The environment a program runs with: the backend's, minus anything that looks like a credential.
function commandEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CREDENTIAL_NAME.test(name)) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * Starts a program with the credential filter applied to its environment.
 *
 * @param argv The program and its arguments.
 * @param cwd The folder the program runs in.
 * @returns The running process.
 */
export function startProcess(argv: string[], cwd: string) {
  return Bun.spawn(argv, {
    cwd,
    env: commandEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * What a finished program left behind: its exit code and its output.
 */
export interface CapturedOutput {
  /** The exit code the program returned. */
  code: number;
  /** The output, cut to the character limit. */
  output: string;
}

/**
 * Output read from one or more streams, and whether reading stopped at the limit.
 */
export interface Capture {
  /** The text read so far. */
  text: string;
  /** True once the text passed the limit, and reading stopped. */
  cut: boolean;
}

/**
 * The note that ends output cut at the limit.
 *
 * @returns The note to append to the cut output.
 */
export function cutNote(): string {
  return `
... cut at ${String(MAX_CHARS)} characters`;
}

/**
 * Reads one output stream into a capture as it arrives. Past the limit it stops reading and calls
 * onCut, so a program that prints without end cannot fill memory. Streams may share a capture:
 * once it is cut, every reader stops.
 *
 * @param stream The stream to read.
 * @param capture Where the text is kept.
 * @param onCut Called once the text passes the limit.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  capture: Capture,
  onCut: () => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return;
    }
    if (capture.cut) {
      await reader.cancel();
      return;
    }
    capture.text += decoder.decode(chunk.value, { stream: true });
    if (capture.text.length > MAX_CHARS) {
      capture.text = capture.text.slice(0, MAX_CHARS);
      capture.cut = true;
      await reader.cancel();
      onCut();
      return;
    }
  }
}

/**
 * Runs a program and returns its exit code and its output as text, cut to MAX_CHARS. Output is
 * read as it arrives, and a program that runs past the timeout is stopped without waiting on
 * its output.
 *
 * @param argv The program and its arguments.
 * @param cwd The folder the program runs in.
 * @param timeoutMs How long it may run before it is stopped.
 * @returns The exit code and the capped output, or an error when it could not start or timed out.
 */
export async function runCaptured(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<Result<CapturedOutput, string>> {
  let proc: ReturnType<typeof startProcess>;
  try {
    proc = startProcess(argv, cwd);
  } catch {
    return err("The command could not be started.");
  }
  const stopProcess = () => {
    proc.kill();
  };
  const stdout: Capture = { text: "", cut: false };
  const stderr: Capture = { text: "", cut: false };
  const finished = Promise.all([
    readCapped(proc.stdout, stdout, stopProcess),
    readCapped(proc.stderr, stderr, stopProcess),
    proc.exited,
  ]);
  const state = {
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  const timedOut = new Promise<undefined>((resolve) => {
    state.timer = setTimeout(() => {
      proc.kill();
      resolve(undefined);
    }, timeoutMs);
  });
  const result = await Promise.race([finished, timedOut]);
  clearTimeout(state.timer);
  if (result === undefined) {
    return err(
      `The command was stopped after ${String(timeoutMs / 1000)} seconds.`,
    );
  }
  const code = result[2];
  const output = `stdout:
${stdout.text}
stderr:
${stderr.text}`;
  const cut = stdout.cut || stderr.cut || output.length > MAX_CHARS;
  return ok({
    code,
    output: cut ? `${output.slice(0, MAX_CHARS)}${cutNote()}` : output,
  });
}
