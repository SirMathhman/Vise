// The tool registry and dispatch. The only module that reads or writes the
// filesystem and executes external processes. No fetch, no stdin/stdout.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Tool } from "./llm/types.ts";

// The tool schemas sent to the model in the request's `tools` field.
export const tools: Tool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file. The path is resolved relative to the working directory. Returns the file's text content, or an error message if the file cannot be read.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to read.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit a file by replacing the first occurrence of replacee with replacement. The path is resolved relative to the working directory. The file must already exist. If replacee is not found, no change is made and an error is returned. Only the first occurrence is replaced.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to edit.",
          },
          replacee: {
            type: "string",
            description:
              "The exact text to find. It must match exactly, including whitespace and indentation.",
          },
          replacement: {
            type: "string",
            description: "The exact text to replace it with.",
          },
        },
        required: ["path", "replacee", "replacement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Create a new file with the given content. The path is resolved relative to the working directory. Parent directories are created if they do not exist. If the file already exists, an error is returned and the file is unchanged.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to create.",
          },
          content: {
            type: "string",
            description: "The content to write to the file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description:
        "Create a new directory. The path is resolved relative to the working directory. Parent directories are created if they do not exist. If the directory already exists, an error is returned.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the directory to create.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_powershell",
      description:
        "Run a PowerShell command. If the command does not finish within the timeout, the process is kept running in the background and a process ID is returned. Use wait_for_process or kill_process to manage it.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The PowerShell command or script to execute.",
          },
          timeout: {
            type: "number",
            description:
              "How long (in seconds) to wait for the command to finish before returning control. The process is not killed when this elapses.",
          },
        },
        required: ["command", "timeout"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_for_process",
      description:
        "Wait for a background process to finish. Returns its output if it has finished, or a message saying it is still running if the timeout elapses.",
      parameters: {
        type: "object",
        properties: {
          process_id: {
            type: "string",
            description: "The ID of the process returned by run_powershell.",
          },
          timeout: {
            type: "number",
            description: "How long (in seconds) to wait.",
          },
        },
        required: ["process_id", "timeout"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_process",
      description:
        "Kill a background process that was started by run_powershell. Returns any output collected so far.",
      parameters: {
        type: "object",
        properties: {
          process_id: {
            type: "string",
            description: "The ID of the process returned by run_powershell.",
          },
        },
        required: ["process_id"],
      },
    },
  },
];

// --- Background process tracking ---

interface TrackedProcess {
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

// Per-tool handlers. Each takes the raw argument bag and returns a string
// result. Unknown tools and read failures are reported as strings so the
// model can see them.
const handlers: Record<
  string,
  (args: Record<string, unknown>, tracker: ProcessTracker) => Promise<string>
> = {
  read_file: async (args) => {
    const rawPath = String(args.path ?? "");
    const filePath = path.resolve(process.cwd(), rawPath);
    try {
      return readFileSync(filePath, "utf-8");
    } catch (err) {
      return `Error reading ${rawPath}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
  edit_file: async (args) => {
    const rawPath = String(args.path ?? "");
    const filePath = path.resolve(process.cwd(), rawPath);
    const replacee = String(args.replacee ?? "");
    const replacement = String(args.replacement ?? "");
    let contents: string;
    try {
      contents = readFileSync(filePath, "utf-8");
    } catch (err) {
      return `Error reading ${rawPath}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    const index = contents.indexOf(replacee);
    if (index < 0) {
      if (replacee.length === 0) {
        return `No change: replacee is empty, so ${rawPath} is unchanged.`;
      }
      return `No change: replacee was not found in ${rawPath}. Read the file and retry with the exact text.`;
    }
    const updated =
      contents.slice(0, index) +
      replacement +
      contents.slice(index + replacee.length);
    try {
      writeFileSync(filePath, updated, "utf-8");
    } catch (err) {
      return `Error writing ${rawPath}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    return `Edited ${rawPath}: replaced ${replacee.length} character(s) starting at offset ${index}.`;
  },
  create_file: async (args) => {
    const rawPath = String(args.path ?? "");
    const filePath = path.resolve(process.cwd(), rawPath);
    const content = String(args.content ?? "");
    if (existsSync(filePath)) {
      return `Error creating ${rawPath}: file already exists.`;
    }
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf-8");
    } catch (err) {
      return `Error creating ${rawPath}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    return `Created ${rawPath} (${content.length} character(s)).`;
  },
  create_directory: async (args) => {
    const rawPath = String(args.path ?? "");
    const filePath = path.resolve(process.cwd(), rawPath);
    if (existsSync(filePath)) {
      return `Error creating ${rawPath}: directory already exists.`;
    }
    try {
      mkdirSync(filePath, { recursive: true });
    } catch (err) {
      return `Error creating ${rawPath}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    return `Created directory ${rawPath}.`;
  },
  run_powershell: async (args, tracker) => {
    const command = String(args.command ?? "");
    const timeout = Number(args.timeout ?? 30);
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
  },
  wait_for_process: async (args, tracker) => {
    const id = String(args.process_id ?? "");
    const timeout = Number(args.timeout ?? 30);
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
  },
  kill_process: async (args, tracker) => {
    const id = String(args.process_id ?? "");
    const t = tracker.get(id);
    if (!t)
      return `No process with id "${id}". It may have already finished or been killed.`;
    t.proc.kill();
    await t.proc.exited;
    tracker.remove(id);
    return `Killed process ${id}.\n\n${formatProcessResult(t)}`;
  },
};

// Dispatches a tool call by name. Adding a tool means adding one entry to
// the `handlers` table and one schema to `tools` — no edit to this function.
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  tracker: ProcessTracker,
): Promise<string> {
  const handler = handlers[name];
  return handler ? handler(args, tracker) : `Unknown tool: ${name}`;
}
