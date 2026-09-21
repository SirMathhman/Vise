// Background process tracking and the three process tool handlers.
// The only module that calls Bun.spawn.
import type { ToolContext } from "../tools.ts";

export interface TrackedProcess {
  proc: Bun.Subprocess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  finished: boolean;
}

function spawnPowerShell(command: string): Bun.Subprocess {
  return Bun.spawn(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
}

function track(
  proc: Bun.Subprocess,
  append: (t: TrackedProcess, key: "stdout" | "stderr", chunk: string) => void,
): TrackedProcess {
  const t: TrackedProcess = {
    proc,
    stdout: "",
    stderr: "",
    exitCode: null,
    finished: false,
  };
  const pump = (
    stream: ReadableStream<Uint8Array> | null,
    key: "stdout" | "stderr",
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(t, key, decoder.decode(value));
      }
    })();
  };
  pump(proc.stdout as ReadableStream<Uint8Array> | null, "stdout");
  pump(proc.stderr as ReadableStream<Uint8Array> | null, "stderr");
  proc.exited.then((code) => {
    t.exitCode = code;
    t.finished = true;
  });
  return t;
}

function formatProcessResult(t: TrackedProcess): string {
  const parts: string[] = [];
  if (t.stdout.trim()) parts.push(`stdout:\n${t.stdout.trim()}`);
  if (t.stderr.trim()) parts.push(`stderr:\n${t.stderr.trim()}`);
  if (t.exitCode !== null && t.exitCode !== 0) {
    parts.push(`exit code: ${t.exitCode}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : "(no output)";
}

// Output kept per tracked process. Anything beyond this budget is replaced
// with a marker so a chatty long-running process cannot bloat the
// conversation.
const OUTPUT_BUDGET = 16_000;
const OUTPUT_MARKER =
  "\n… (output truncated; keep it under 16000 characters) …\n";

// Owns the set of tracked background processes. Constructed by the loop;
// tools receive it as a parameter so the module holds no mutable state.
export class ProcessTracker {
  private map = new Map<string, TrackedProcess>();
  private nextId = 1;

  spawn(command: string): { id: string; t: TrackedProcess } {
    const t = track(spawnPowerShell(command), this.append);
    const id = String(this.nextId++);
    this.map.set(id, t);
    return { id, t };
  }

  get(id: string): TrackedProcess | undefined {
    return this.map.get(id);
  }

  remove(id: string): void {
    this.map.delete(id);
  }

  // Kill every tracked process and clear the map. Called by the loop on exit
  // so background subprocesses are not orphaned.
  async shutdown(): Promise<void> {
    const pending = [...this.map.values()].filter((t) => !t.finished);
    for (const t of pending) {
      t.proc.kill();
    }
    await Promise.all(pending.map((t) => t.proc.exited));
    this.map.clear();
  }

  private append = (
    t: TrackedProcess,
    key: "stdout" | "stderr",
    chunk: string,
  ) => {
    const rest = OUTPUT_BUDGET - t[key].length;
    if (rest > 0) t[key] += chunk.slice(0, rest);
    if (t[key].length >= OUTPUT_BUDGET) t[key] += OUTPUT_MARKER;
  };
}

// Process tool handlers. Each takes the raw argument bag and a ToolContext.
// The ProcessTracker is accessed via ctx.tracker.

export const run_powershell = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> => {
  const command = String(args.command ?? "");
  const timeout = Number(args.timeout ?? 30);
  const tracker = ctx.tracker;
  const { id, t } = tracker.spawn(command);
  await Promise.race([
    t.proc.exited,
    new Promise((r) => setTimeout(r, timeout * 1000)),
  ]);
  if (t.finished) {
    tracker.remove(id);
    return formatProcessResult(t);
  }
  return `Process started (id: ${id}), still running after ${timeout}s. Use wait_for_process or kill_process.`;
};

export const wait_for_process = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> => {
  const id = String(args.process_id ?? "");
  const timeout = Number(args.timeout ?? 30);
  const tracker = ctx.tracker;
  const t = tracker.get(id);
  if (!t)
    return `No process with id "${id}". It may have already finished or been killed.`;
  await Promise.race([
    t.proc.exited,
    new Promise((r) => setTimeout(r, timeout * 1000)),
  ]);
  if (t.finished) {
    tracker.remove(id);
    return formatProcessResult(t);
  }
  return `Process ${id} is still running after ${timeout}s.`;
};

export const kill_process = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> => {
  const id = String(args.process_id ?? "");
  const tracker = ctx.tracker;
  const t = tracker.get(id);
  if (!t)
    return `No process with id "${id}". It may have already finished or been killed.`;
  t.proc.kill();
  await t.proc.exited;
  tracker.remove(id);
  return `Killed process ${id}.\n\n${formatProcessResult(t)}`;
};
