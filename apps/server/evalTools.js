import { readdirSync } from "node:fs";
import { sep } from "node:path";
import { Script, createContext } from "node:vm";
import { repoRoot } from "./listing.js";
import { resolveWithin } from "./pathGuard.js";

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
 * In-memory store of functions the model defines via create_function.
 * Keyed by function name; values are the raw source code. Lives for the
 * process lifetime (cleared on backend restart).
 */
const functionStore = new Map();

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

export const evalExpression = {
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
        'listDirectory(path) function lists a repository directory ("" for ' +
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
