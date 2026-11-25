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

function startProcess(argv: string[], cwd: string) {
  return Bun.spawn(argv, {
    cwd,
    env: commandEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

// Reads one output stream up to the limit. Past the limit it stops reading and calls
// onCut, so a program that prints without end cannot fill memory.
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onCut: () => void,
): Promise<{ text: string; cut: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return { text, cut: false };
    }
    text += decoder.decode(chunk.value, { stream: true });
    if (text.length > limit) {
      await reader.cancel();
      onCut();
      return { text: text.slice(0, limit), cut: true };
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
): Promise<Result<{ code: number; output: string }, string>> {
  let proc: ReturnType<typeof startProcess>;
  try {
    proc = startProcess(argv, cwd);
  } catch {
    return err("The command could not be started.");
  }
  const stopProcess = () => {
    proc.kill();
  };
  const finished = Promise.all([
    readCapped(proc.stdout, MAX_CHARS, stopProcess),
    readCapped(proc.stderr, MAX_CHARS, stopProcess),
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
  const [stdout, stderr, code] = result;
  const output = `stdout:\n${stdout.text}\nstderr:\n${stderr.text}`;
  const cut = stdout.cut || stderr.cut || output.length > MAX_CHARS;
  return ok({
    code,
    output: cut
      ? `${output.slice(0, MAX_CHARS)}\n... cut at ${String(MAX_CHARS)} characters`
      : output,
  });
}
