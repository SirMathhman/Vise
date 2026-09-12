import { Script, createContext } from "node:vm";
import { functionStore, EVAL_BUILTINS } from "./evalTools.js";

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
