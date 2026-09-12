import {
  readdirSync,
  readFileSync as fsReadFile,
  writeFileSync as fsWriteFile,
  statSync as fsStat,
  mkdirSync as fsMkdir,
} from "node:fs";
import { sep, dirname } from "node:path";
import { Script, createContext } from "node:vm";
import { repoRoot } from "./listing.js";
import { resolveWithin } from "./pathGuard.js";
import { runPowershell, searchFiles } from "./processTools.js";

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
    if (err.code === "ENOENT") throw new Error(`No such directory: ${path}`);
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

/**
 * Built-in `readFile` available inside `eval` expressions. Reads the text
 * content of a file in the repository (path relative to the repository root).
 * Throws a descriptive error if the file does not exist or is not a regular
 * file. Returns the file's content, truncated at 100,000 characters.
 * Synchronous, so it can be called directly from an eval expression.
 * @param {string} path - File path relative to the repository root.
 * @returns {string}
 */
const readFile = (path) => {
  const file = resolveWithin(repoRoot, path);
  if (!file) throw new Error("Invalid path (must be within the repository)");
  let info;
  try {
    info = fsStat(file);
  } catch {
    throw new Error(`No such file: ${path}`);
  }
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  const content = fsReadFile(file, "utf8");
  const MAX_CHARS = 100_000;
  if (content.length > MAX_CHARS) {
    return (
      content.slice(0, MAX_CHARS) +
      `\n\n[truncated: file is ${content.length} characters, showing first ${MAX_CHARS}]`
    );
  }
  return content;
};

/**
 * Built-in `writeFile` available inside `eval` expressions. Writes a file to
 * the repository (path relative to the repository root). Creates parent
 * directories automatically. Throws if the path is not a string, the file
 * already exists, or the write fails. Records the write in the module-level
 * `fileEdits` array so the caller can pick it up after eval finishes.
 * Returns a confirmation string with the path and character count.
 * @param {string} path - File path relative to the repository root.
 * @param {string} content - The content to write to the new file.
 * @returns {string}
 */
const writeFile = (path, content) => {
  const file = resolveWithin(repoRoot, path);
  if (!file) throw new Error("Invalid path (must be within the repository)");
  if (typeof content !== "string") throw new Error("content must be a string");
  let info;
  try {
    info = fsStat(file);
    if (info.isFile()) throw new Error(`File already exists: ${path}`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  fsMkdir(dirname(file), { recursive: true });
  fsWriteFile(file, content, "utf8");
  fileEdits.push({ path, content });
  return `Created ${path} (${content.length} characters).`;
};

/**
 * Built-in `editFile` available inside `eval` expressions. Overwrites an
 * existing file in the repository (path relative to the repository root).
 * Throws if the path is not a string, the file does not exist, or the write
 * fails. Records the write in the module-level `fileEdits` array so the
 * caller can pick it up after eval finishes.
 * Returns a confirmation string with the path and character count.
 * @param {string} path - File path relative to the repository root.
 * @param {string} content - The full new content to write to the file.
 * @returns {string}
 */
const editFile = (path, content) => {
  const file = resolveWithin(repoRoot, path);
  if (!file) throw new Error("Invalid path (must be within the repository)");
  if (typeof content !== "string") throw new Error("content must be a string");
  let info;
  try {
    info = fsStat(file);
  } catch {
    throw new Error(`File does not exist: ${path}`);
  }
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  fsWriteFile(file, content, "utf8");
  fileEdits.push({ path, content });
  return `Edited ${path} (${content.length} characters).`;
};

/**
 * Built-in `createDirectory` available inside `eval` expressions. Creates a
 * directory in the repository (path relative to the repository root).
 * Parent directories are created automatically. Throws if the path is
 * not a string, the path is invalid, a file already exists at that path,
 * or the creation fails.
 * Returns a confirmation string with the path.
 * @param {string} path - Directory path relative to the repository root.
 * @returns {string}
 */
const createDirectory = (path) => {
  const dir = resolveWithin(repoRoot, path);
  if (!dir) throw new Error("Invalid path (must be within the repository)");
  let info;
  try {
    info = fsStat(dir);
    if (info.isFile())
      throw new Error(`A file with this name already exists: ${path}`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  fsMkdir(dir, { recursive: true });
  return `Created directory ${path}.`;
};

/**
 * In-memory store of functions the model defines via create_function.
 * Keyed by function name; values are the raw source code. Lives for the
 * process lifetime (cleared on backend restart).
 */
const functionStore = new Map();

/**
 * File writes made during the current chat turn, so the caller can pick them
 * up after `eval` finishes and forward them to the client (for live file-viewer
 * updates). Drained by `drainFileEdits` after each eval call.
 */
const fileEdits = [];

export const drainFileEdits = () => {
  return fileEdits.splice(0);
};

/**
 * Sandbox wrappers for the process tools, so they can be called directly
 * from eval expressions (e.g. eval("runPowershell('dir')")). These delegate
 * to the async executors in processTools.js.
 */
const runPowershellFn = (command) => runPowershell({ command });
const searchFilesFn = (pattern) => searchFiles({ pattern });

/**
 * The built-in functions exposed in the eval sandbox. Each entry's `name` is
 * what the sandbox exposes and what an eval expression calls, `fn` is the
 * implementation wired into the sandbox, and `description` is the short
 * human-readable blurb shown in the UI's eval-functions reference. Defined
 * here as the single source of truth so the sandbox wiring and the UI listing
 * can never drift apart.
 */
const EVAL_BUILTINS = [
  {
    name: "listDirectory",
    fn: listDirectory,
    description:
      'Lists a repository directory ("" for the root); returns { name, isDirectory } entries.',
  },
  {
    name: "readFile",
    fn: readFile,
    description:
      "Reads a file's text content (truncated at 100,000 characters).",
  },
  {
    name: "writeFile",
    fn: writeFile,
    description:
      "Creates a new file, making parent directories; fails if the file already exists.",
  },
  {
    name: "editFile",
    fn: editFile,
    description: "Overwrites the full content of an existing file.",
  },
  {
    name: "createDirectory",
    fn: createDirectory,
    description: "Creates a directory, making parent directories.",
  },
  {
    name: "runPowershell",
    fn: runPowershellFn,
    description:
      "Runs a PowerShell command in the repo root (async); returns output + exit code.",
  },
  {
    name: "searchFiles",
    fn: searchFilesFn,
    description:
      "Searches repo file names by regex (async); returns matching relative paths.",
  },
];

/**
 * Lists every function that can be executed inside an eval expression: the
 * built-in file I/O / directory functions plus any functions the model has
 * defined via create_function (live from the in-memory store). Used by the
 * /api/eval-functions endpoint so the UI can show what eval can call without
 * hardcoding a second copy of the list.
 * @returns {Array<{name: string, description: string, builtin: boolean}>}
 */
export function getEvalFunctions() {
  const builtins = EVAL_BUILTINS.map(({ name, description }) => ({
    name,
    description,
    builtin: true,
  }));
  const created = [...functionStore.entries()].map(([name, code]) => ({
    name,
    description: code,
    builtin: false,
  }));
  return [...builtins, ...created];
}

export const listEvalFunctions = {
  name: "list_eval_functions",
  label: "List eval functions",
  icon: "📋",
  summary: () => "",
  definition: {
    type: "function",
    function: {
      name: "list_eval_functions",
      description:
        "Lists every function that can be called inside an eval expression: " +
        "the built-in file I/O and directory functions plus any functions " +
        "previously defined via create_function. Use this when the user asks " +
        "what functions are available, what they can call with eval, or which " +
        "functions are defined.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  async execute() {
    const functions = getEvalFunctions();
    const lines = functions.map((fn) => {
      const source = fn.builtin ? "built-in" : "create_function";
      return `  ${fn.name} (${source}) — ${fn.description}`;
    });
    return `Functions available in eval:\n${lines.join("\n")}`;
  },
};

export const createFunction = {
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

export const deleteFunction = {
  name: "delete_function",
  label: "Delete function",
  icon: "🗑️",
  summary: (args) => args?.name ?? "",
  definition: {
    type: "function",
    function: {
      name: "delete_function",
      description:
        "Remove a function that was previously defined via create_function so " +
        "it can no longer be called by name in eval expressions. Use this to " +
        "clean up a function that is no longer needed. Built-in functions " +
        "(such as readFile, writeFile, listDirectory, runPowershell, and " +
        "searchFiles) are not stored in the function store and cannot be " +
        "deleted. If the name does not match a previously created function, " +
        "this tool reports that no such function exists.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The name of the function to delete (a name previously " +
              'defined via create_function, e.g. "add").',
          },
        },
        required: ["name"],
      },
    },
  },
  async execute(args) {
    const name = args?.name;
    if (typeof name !== "string" || name.trim() === "") {
      return "Missing required parameter: name.";
    }
    if (!functionStore.has(name)) {
      return `No such function to delete: ${name} (only functions defined via create_function can be deleted; built-ins cannot).`;
    }
    functionStore.delete(name);
    return `Deleted function: ${name}`;
  },
};

export const evalExpression = {
  name: "eval",
  label: "Eval",
  icon: "🧮",
  summary: (args) => (args?.expression ? `"${args.expression}"` : ""),
  // Tools with side effects (file writes) advertise a `drain` function that
  // returns any pending side-effect records since the last call. The tool
  // loop in chat.js calls `tool.drain?.()` after each tool runs and forwards
  // each record to the client, so the loop stays tool-agnostic and the
  // side-effect contract lives on the tool entry, not in chat.js.
  drain: drainFileEdits,
  definition: {
    type: "function",
    function: {
      name: "eval",
      description:
        "Evaluate a JavaScript expression and return its value. Use this " +
        'to compute or transform values, e.g. eval("1 + 2") => 3. The ' +
        "expression runs in a sandbox with a 2 second timeout. Built-in " +
        "functions available in the sandbox: listDirectory(path) (lists a " +
        'repository directory, "" for the root), readFile(path) (reads a ' +
        "file's text content), writeFile(path, content) (creates a new file, " +
        "creating parent directories), editFile(path, content) (overwrites an " +
        "existing file), createDirectory(path) (creates a directory, " +
        "creating parent directories), runPowershell(command) (runs a " +
        "PowerShell command in the repo root, async), and searchFiles(pattern) " +
        "(searches repo file names by regex, async). Any functions previously " +
        "defined with create_function are also available by name. Only the " +
        "value of the final expression is returned, like a REPL: use " +
        'eval("1 + 2") => 3. Note that runPowershell and searchFiles are ' +
        "async: if you call them, await their result.",
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
      // Build a sandbox context pre-populated with the built-in file I/O
      // functions and all stored functions.
      const sandbox = createContext();
      for (const { name, fn } of EVAL_BUILTINS) {
        sandbox[name] = fn;
      }
      for (const [name, code] of functionStore) {
        const wrapped = `(${code})`;
        sandbox[name] = new Script(wrapped).runInNewContext(sandbox, {
          timeout: 1000,
        });
      }
      // Wrap the expression in an async IIFE so top-level `await` works
      // (vm.Script does not support top-level await). Awaiting the returned
      // Promise auto-flattens a forgotten `await` and passes sync values
      // through unchanged.
      const script = new Script(`(async () => (${args.expression}))()`);
      const value = await script.runInContext(sandbox, { timeout: 2000 });
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
