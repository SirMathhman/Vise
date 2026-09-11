import { writeFile, mkdir, stat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { dirname, sep } from "node:path";
import { execFile } from "node:child_process";
import { Script, createContext } from "node:vm";
import { getFileContent, repoRoot } from "./listing.js";
import { resolveWithin } from "./pathGuard.js";
import {
  takeNote,
  updateNoteTool,
  deleteNoteTool,
  recallNotes,
} from "./notesTools.js";

/**
 * A tool the model can call. Its definition (sent to the LLM) and executor
 * (run server-side) live together so the tool contract is defined exactly
 * once. Adding a tool is a single-file change.
 */
/**
 * Built-in `listDirectory` available inside `eval` expressions. Lists a
 * directory of the repository (path relative to the repository root; omit it
 * or pass "" for the root) and returns an array of `{ name, isDirectory }`
 * entries, sorted alphabetically; directory names carry a trailing path
 * separator so they are visually distinguishable from files. Throws a
 * descriptive error on an invalid path or a directory that does not exist.
 * Synchronous, so it can be called directly from an eval expression.
 * @param {string} [path] - Directory path relative to the repository root.
 * @returns {Array<{name: string, isDirectory: boolean}>}
 */
const listDirectory = (path = "") => {
  const dir = resolveWithin(repoRoot, path);
  if (!dir) throw new Error("Invalid path (must be within the repository)");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT")
      throw new Error(`No such directory: ${path}`);
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() || e.isFile())
    .map((e) => ({
      name: e.name + (e.isDirectory() ? sep : ""),
      isDirectory: e.isDirectory(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

const readFile = {
  name: "read_file",
  label: "Read file",
  icon: "📄",
  summary: (args) => args?.path ?? "",
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the text content of a file in the repository. " +
        "Use this to answer questions about what a file contains.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'File path relative to the repository root (e.g. "apps/server/chat.js").',
          },
        },
        required: ["path"],
      },
    },
  },
  async execute(args) {
    const file = resolveWithin(repoRoot, args?.path ?? "");
    if (!file) return "Invalid path (must be within the repository).";
    try {
      const content = await getFileContent(file);
      const MAX_CHARS = 100_000;
      if (content.length > MAX_CHARS) {
        return (
          content.slice(0, MAX_CHARS) +
          `\n\n[truncated: file is ${content.length} characters, showing first ${MAX_CHARS}]`
        );
      }
      return content;
    } catch (err) {
      return `Could not read file: ${err.message}`;
    }
  },
};

const createFile = {
  name: "create_file",
  label: "Create file",
  icon: "📝",
  writesFile: true,
  summary: (args) => args?.path ?? "",
  definition: {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Create a new file in the repository. " +
        "Fails if the file already exists. Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'File path relative to the repository root (e.g. "apps/server/chat.js").',
          },
          content: {
            type: "string",
            description: "The content to write to the new file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args) {
    const file = resolveWithin(repoRoot, args?.path ?? "");
    if (!file)
      return { result: "Invalid path (must be within the repository)." };
    if (typeof args?.content !== "string")
      return { result: "Missing required parameter: content." };
    try {
      await stat(file);
      return { result: `File already exists: ${args.path}` };
    } catch (err) {
      if (err.code !== "ENOENT")
        return { result: `Could not create file: ${err.message}` };
    }
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, args.content, "utf8");
      return {
        result: `Created ${args.path} (${args.content.length} characters).`,
        file: { path: args.path, content: args.content },
      };
    } catch (err) {
      return { result: `Could not create file: ${err.message}` };
    }
  },
};

const createDirectory = {
  name: "create_directory",
  label: "Create directory",
  icon: "📂",
  summary: (args) => args?.path ?? "",
  definition: {
    type: "function",
    function: {
      name: "create_directory",
      description:
        "Create a new directory in the repository. " +
        "Fails if the path already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Directory path relative to the repository root (e.g. "apps/server/utils").',
          },
        },
        required: ["path"],
      },
    },
  },
  async execute(args) {
    const dir = resolveWithin(repoRoot, args?.path ?? "");
    if (!dir) return "Invalid path (must be within the repository).";
    try {
      const info = await stat(dir);
      if (info.isDirectory()) return `Directory already exists: ${args.path}`;
      return `A file with this name already exists: ${args.path}`;
    } catch (err) {
      if (err.code !== "ENOENT")
        return `Could not create directory: ${err.message}`;
    }
    try {
      await mkdir(dir, { recursive: true });
      return `Created directory ${args.path}.`;
    } catch (err) {
      return `Could not create directory: ${err.message}`;
    }
  },
};

const editFile = {
  name: "edit_file",
  label: "Edit file",
  icon: "✏️",
  writesFile: true,
  summary: (args) => args?.path ?? "",
  definition: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Modify an existing file in the repository. " +
        "Fails if the file does not exist. Read the file first to see its current content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'File path relative to the repository root (e.g. "apps/server/chat.js").',
          },
          content: {
            type: "string",
            description: "The full new content to write to the file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args) {
    const file = resolveWithin(repoRoot, args?.path ?? "");
    if (!file)
      return { result: "Invalid path (must be within the repository)." };
    if (typeof args?.content !== "string")
      return { result: "Missing required parameter: content." };
    try {
      const info = await stat(file);
      if (!info.isFile())
        return { result: `File does not exist: ${args.path}` };
      await writeFile(file, args.content, "utf8");
      return {
        result: `Edited ${args.path} (${args.content.length} characters).`,
        file: { path: args.path, content: args.content },
      };
    } catch (err) {
      if (err.code === "ENOENT")
        return { result: `File does not exist: ${args.path}` };
      return { result: `Could not edit file: ${err.message}` };
    }
  },
};

const runPowershell = {
  name: "run_powershell",
  label: "Run PowerShell",
  icon: "⚡",
  summary: (args) => args?.command ?? "",
  definition: {
    type: "function",
    function: {
      name: "run_powershell",
      description:
        "Run a PowerShell command in the repository and return its output. " +
        "The working directory is the repository root. Use this to run scripts, " +
        "list or process files, check system state, or any task PowerShell handles. " +
        "Returns the command's output plus its exit code.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              'The PowerShell command or script to run (e.g. "Get-ChildItem src" or "npm run lint:all").',
          },
        },
        required: ["command"],
      },
    },
  },
  async execute(args) {
    if (typeof args?.command !== "string" || args.command.trim() === "") {
      return "Missing required parameter: command.";
    }
    return new Promise((resolve) => {
      execFile(
        "pwsh",
        ["-NoProfile", "-NoLogo", "-Command", args.command],
        {
          cwd: repoRoot,
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const MAX_CHARS = 50_000;
          const out = (stdout || "").trim();
          const errOut = (stderr || "").trim();
          const parts = [];
          if (out) parts.push(out);
          if (errOut) parts.push(`[stderr]\n${errOut}`);
          if (!parts.length) parts.push("(no output)");
          const output = parts.join("\n");
          const body =
            output.length > MAX_CHARS
              ? output.slice(0, MAX_CHARS) +
                `

[truncated: output is ${output.length} characters, showing first ${MAX_CHARS}]`
              : output;
          // execFile's `error.code` is a number only for a real non-zero exit:
          // a timeout gives `code = null, killed = true`, a spawn failure
          // (e.g. pwsh not on PATH) gives `code = "ENOENT"`. Report each
          // distinctly so the model can tell "killed" / "couldn't run" from a
          // genuine failure exit code.
          let suffix = "";
          if (error) {
            if (error.killed) {
              suffix = "\n[timed out after 120s]";
            } else if (typeof error.code !== "number") {
              suffix = `\n[could not run pwsh: ${error.code}]`;
            } else {
              suffix = `\n[exit code: ${error.code}]`;
            }
          }
          resolve(body + suffix);
        },
      );
    });
  },
};

const searchFiles = {
  name: "search_files",
  label: "Search files",
  icon: "🔍",
  summary: (args) => args?.pattern ?? "",
  definition: {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search the repository's file names by regular expression, returning " +
        "the relative path of every matching file that is not ignored by " +
        ".gitignore (i.e. files git tracks plus untracked-but-not-ignored " +
        "files). The regex is matched case-insensitively against each file's " +
        "full relative path. Use this to find files by name without listing " +
        "every directory, then read the ones you need. For example, the " +
        'pattern "chat" matches apps/server/chat.js and apps/web/src/chat.js.',
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "A regular expression matched against each file's relative " +
              'path (case-insensitive), e.g. "chat" or ' +
              '"^apps/server/.*\\.js$".',
          },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(args) {
    if (typeof args?.pattern !== "string" || args.pattern === "") {
      return "Missing required parameter: pattern.";
    }
    let re;
    try {
      re = new RegExp(args.pattern, "i");
    } catch (err) {
      return `Invalid regex: ${err.message}`;
    }
    // `git ls-files -co --exclude-standard` lists tracked files plus
    // untracked files that are not ignored, pruning .gitignored directories
    // so it stays fast even with node_modules present. -z gives
    // null-delimited paths so names with spaces/newlines are safe.
    return new Promise((resolve) => {
      execFile(
        "git",
        ["ls-files", "-co", "-z", "--exclude-standard"],
        {
          cwd: repoRoot,
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            // A timeout (e.g. a held git index lock) gives killed = true, a
            // spawn failure (git not on PATH) gives a non-numeric code.
            const suffix = error.killed
              ? " [timed out after 30s]"
              : typeof error.code !== "number"
                ? ` [could not run git: ${error.code}]`
                : ` [exit code: ${error.code}]`;
            return resolve(`Could not search files${suffix}`);
          }
          const paths = String(stdout).split("\0").filter(Boolean);
          const matches = paths.filter((p) => re.test(p));
          const MAX_RESULTS = 200;
          let body;
          if (matches.length === 0) {
            body = `No files match /${args.pattern}/i.`;
          } else {
            body = matches.slice(0, MAX_RESULTS).join("\n");
            if (matches.length > MAX_RESULTS) {
              body += `\n\n[truncated: ${matches.length} matches, showing first ${MAX_RESULTS}]`;
            }
          }
          resolve(body);
        },
      );
    });
  },
};

/**
 * In-memory store of functions the model defines via create_function.
 * Keyed by function name; values are the raw source code. Lives for the
 * process lifetime (cleared on backend restart).
 */
const functionStore = new Map();

const createFunction = {
  name: "create_function",
  label: "Create function",
  icon: "🔤",
  summary: (args) => args?.name ?? "",
  definition: {
    type: "function",
    function: {
      name: "create_function",
      description:
        "Define a named function that can be called by name in later eval " +
        "expressions. Use this to break a computation into named pieces so " +
        "you can reference the function by name in eval without re-defining " +
        "it. The function body runs in the same isolated sandbox as eval " +
        "(no access to require, process, or globals). Redefining a name " +
        "overwrites the previous definition.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The name to give the function (a valid JS identifier, " +
              'e.g. "add" or "fib").',
          },
          code: {
            type: "string",
            description:
              "The full function source as an expression, e.g. " +
              '"(a, b) => a + b" or "function(a, b) { return a + b; }".',
          },
        },
        required: ["name", "code"],
      },
    },
  },
  async execute(args) {
    const name = args?.name;
    const code = args?.code;
    if (typeof name !== "string" || name.trim() === "") {
      return "Missing required parameter: name.";
    }
    if (typeof code !== "string" || code.trim() === "") {
      return "Missing required parameter: code.";
    }
    // Validate that the code is a parseable function expression by
    // evaluating it wrapped in parens (e.g. "(a, b) => a + b" becomes
    // "((a, b) => a + b)").
    try {
      const fn = new Script(`(${code})`).runInNewContext(createContext(), {
        timeout: 1000,
      });
      if (typeof fn !== "function") {
        return `Code is not a function: ${code}`;
      }
      functionStore.set(name, code);
      return `Created function: ${name}`;
    } catch (err) {
      return `Could not create function: ${err.message}`;
    }
  },
};

const evalExpression = {
  name: "eval",
  label: "Eval",
  icon: "🧮",
  summary: (args) => (args?.expression ? `"${args.expression}"` : ""),
  definition: {
    type: "function",
    function: {
      name: "eval",
      description:
        "Evaluate a JavaScript expression and return its value. Use this " +
        'to compute or transform values, e.g. eval("1 + 2") => 3. The ' +
        "expression runs in a sandbox with a 2 second timeout. The built-in " +
        "listDirectory(path) function lists a repository directory (\"\" for " +
        "the root), returning an array of { name, isDirectory } entries. Any " +
        "functions previously defined with create_function are also available " +
        "by name. Only the value of the final expression is returned, like " +
        'a REPL: use eval("1 + 2") => 3, or after create_function with ' +
        'name "add" and code "(a,b) => a+b", use eval("add(2,3)") => 5.',
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description:
              'A JavaScript expression to evaluate (e.g. "1 + 2", ' +
              '"add(2, 3)", or "[1, 2, 3].map((x) => x * 2)").',
          },
        },
        required: ["expression"],
      },
    },
  },
  async execute(args) {
    if (typeof args?.expression !== "string" || args.expression === "") {
      return "Missing required parameter: expression.";
    }
    try {
      // Build a sandbox context pre-populated with the built-in listDirectory
      // function and all stored functions.
      const sandbox = createContext();
      sandbox.listDirectory = listDirectory;
      for (const [name, code] of functionStore) {
        const wrapped = `(${code})`;
        sandbox[name] = new Script(wrapped).runInNewContext(sandbox, {
          timeout: 1000,
        });
      }
      const script = new Script(args.expression);
      const value = script.runInContext(sandbox, { timeout: 2000 });
      let text;
      if (value === null || value === undefined) {
        text = String(value);
      } else if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        text = String(value);
      } else {
        try {
          text = JSON.stringify(value);
        } catch {
          text = String(value);
        }
        if (text === undefined) text = String(value);
      }
      const MAX_CHARS = 10_000;
      if (text.length > MAX_CHARS) {
        return (
          text.slice(0, MAX_CHARS) +
          `\n\n[truncated: result is ${text.length} characters, showing first ${MAX_CHARS}]`
        );
      }
      return text;
    } catch (err) {
      if (err && /timed out/i.test(err.message)) {
        return "Evaluation timed out after 2s.";
      }
      return `Could not evaluate: ${err.message}`;
    }
  },
};

/**
 * The registry of tools available to the model. The note tools live in
 * notesTools.js (a per-domain tool module) and are re-exported here so the
 * LLM sees a single registry.
 */
export const TOOLS = [
  readFile,
  createFile,
  createDirectory,
  editFile,
  runPowershell,
  searchFiles,
  createFunction,
  evalExpression,
  takeNote,
  updateNoteTool,
  deleteNoteTool,
  recallNotes,
];
