// The tool registry and dispatch. The only module that reads or writes the
// filesystem and executes external processes. No fetch, no stdin/stdout.
import type { Dirent } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import type { Tool } from "./llm/types.ts";

// The tool schemas sent to the model in the request's `tools` field.
export const tools: Tool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file. The path is resolved relative to the working directory. Returns the file's text content, or an error message if the file cannot be read. Optionally, startLine and endLine (1-based, inclusive) limit which lines are returned. At most 500 lines are returned; if the range exceeds this, it is capped.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to read.",
          },
          startLine: {
            type: "number",
            description:
              "The 1-based line number to start reading from. Defaults to 1.",
          },
          endLine: {
            type: "number",
            description:
              "The 1-based inclusive line number to stop at. Defaults to the last line. Capped at startLine + 499 (500 lines max).",
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
      name: "list_directory",
      description:
        "List the contents of a directory as an indented tree. The path is resolved relative to the working directory. The depth parameter controls how many levels deep to recurse. Returns file and directory names with their relative paths.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "The path to the directory to list. Defaults to the current working directory.",
          },
          depth: {
            type: "number",
            description:
              "How many levels deep to recurse. Defaults to 1. Capped at 5.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description:
        "Search for files whose names match a pattern. Recursively searches under the path (default the working directory), skipping node_modules and .git. The pattern is a case-insensitive glob where * matches any run of characters. Returns matching file paths relative to the working directory.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              'The filename pattern to match, e.g. "*.ts" or "config".',
          },
          path: {
            type: "string",
            description:
              "Directory to search under. Defaults to the working directory.",
          },
          maxResults: {
            type: "number",
            description:
              "Maximum number of matches to return. Defaults to 100.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_content",
      description:
        "Search for a text pattern in file contents. Searches the path (a directory searched recursively, or a single file), skipping node_modules and .git. Returns matching lines with their file path and line number. Case-insensitive by default.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The text to search for.",
          },
          path: {
            type: "string",
            description:
              "Directory to search under, or a single file. Defaults to the working directory.",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of matches to return. Defaults to 50.",
          },
          caseSensitive: {
            type: "boolean",
            description:
              "Whether matching is case-sensitive. Defaults to false.",
          },
        },
        required: ["pattern"],
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

// Directory names skipped while walking for find_files and search_content,
// so results stay bounded and focused on the project rather than
// dependency or VCS internals.
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// Yields every file under root (including root if it is a file), recursing
// into subdirectories while skipping SKIP_DIRS. Stack-based so deep trees
// cannot overflow the call stack.
function* walkFiles(root: string): Generator<string, void, undefined> {
  if (existsSync(root) && statSync(root).isFile()) {
    yield root;
    return;
  }
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

// A file path relative to the working directory, so the model can feed the
// result straight back into read_file.
function displayPath(fullPath: string): string {
  const rel = path.relative(process.cwd(), fullPath);
  return rel.length > 0 ? rel : ".";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const startLine = Math.max(1, Number(args.startLine ?? 1));
    const endLine = Math.max(startLine, Number(args.endLine ?? Infinity));
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const total = lines.length;
      const cappedEnd = Math.min(endLine, startLine + 499);
      const slice = lines.slice(startLine - 1, cappedEnd);
      const prefix =
        startLine > 1 || cappedEnd < total
          ? `Lines ${startLine}–${cappedEnd} of ${total}:\n\n`
          : "";
      return prefix + slice.join("\n");
    } catch (err) {
      return `Error reading ${rawPath}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
  list_directory: async (args) => {
    const rawPath = String(args.path ?? ".");
    const dirPath = path.resolve(process.cwd(), rawPath);
    const depth = Math.max(1, Math.min(5, Number(args.depth ?? 1)));
    if (!existsSync(dirPath)) {
      return `Error listing ${rawPath}: path does not exist.`;
    }
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      return `Error listing ${rawPath}: not a directory.`;
    }
    const lines: string[] = [];
    const walk = (dir: string, indent: number, remaining: number) => {
      const entries = readdirSync(dir);
      for (const name of entries) {
        const fullPath = path.join(dir, name);
        const isDir = statSync(fullPath).isDirectory();
        lines.push(`${"  ".repeat(indent)}${name}${isDir ? "/" : ""}`);
        if (isDir && remaining > 1) {
          walk(fullPath, indent + 1, remaining - 1);
        }
      }
    };
    walk(dirPath, 0, depth);
    return lines.length > 0 ? lines.join("\n") : "(empty directory)";
  },
  find_files: async (args) => {
    const pattern = String(args.pattern ?? "");
    if (pattern.length === 0) return "Error: pattern is empty.";
    const rawPath = String(args.path ?? ".");
    const dirPath = path.resolve(process.cwd(), rawPath);
    const maxResults = Math.max(
      1,
      Math.min(500, Number(args.maxResults ?? 100)),
    );
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      return `Error: ${rawPath} is not a directory.`;
    }
    const regex = new RegExp(
      `^${pattern.split("*").map(escapeRegex).join(".*")}$`,
      "i",
    );
    const matches: string[] = [];
    for (const filePath of walkFiles(dirPath)) {
      if (regex.test(path.basename(filePath))) {
        matches.push(displayPath(filePath));
        if (matches.length >= maxResults) break;
      }
    }
    if (matches.length === 0) {
      return `No files matching "${pattern}" under ${rawPath}.`;
    }
    const suffix =
      matches.length >= maxResults ? `\n\n(Showing first ${maxResults}.)` : "";
    return matches.join("\n") + suffix;
  },
  search_content: async (args) => {
    const pattern = String(args.pattern ?? "");
    if (pattern.length === 0) return "Error: pattern is empty.";
    const rawPath = String(args.path ?? ".");
    const maxResults = Math.max(
      1,
      Math.min(200, Number(args.maxResults ?? 50)),
    );
    const caseSensitive = Boolean(args.caseSensitive ?? false);
    const target = path.resolve(process.cwd(), rawPath);
    if (!existsSync(target)) {
      return `Error: ${rawPath} not found.`;
    }
    const files: string[] = [];
    if (statSync(target).isDirectory()) {
      for (const f of walkFiles(target)) files.push(f);
    } else {
      files.push(target);
    }
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    const matches: string[] = [];
    outer: for (const filePath of files) {
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue; // skip binary
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (raw === undefined) continue;
        const line = caseSensitive ? raw : raw.toLowerCase();
        if (line.includes(needle)) {
          matches.push(
            `${displayPath(filePath)}:${i + 1}: ${raw.replace(/\r$/, "").trim()}`,
          );
          if (matches.length >= maxResults) break outer;
        }
      }
    }
    if (matches.length === 0) {
      return `No matches for "${pattern}" under ${rawPath}.`;
    }
    const suffix =
      matches.length >= maxResults ? `\n\n(Showing first ${maxResults}.)` : "";
    return matches.join("\n") + suffix;
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
