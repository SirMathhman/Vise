import { writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { getListing, getFileContent, repoRoot } from "./listing.js";
import { resolveWithin } from "./pathGuard.js";

/**
 * A tool the model can call. Its definition (sent to the LLM) and executor
 * (run server-side) live together so the tool contract is defined exactly
 * once. Adding a tool is a single-file change.
 */
const listDirectory = {
  name: "list_directory",
  label: "List directory",
  icon: "📁",
  summary: (args) => args?.path ?? "",
  definition: {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List the files and subdirectories in a directory of the repository. " +
        "Use an empty path to list the repository root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Directory path relative to the repository root (e.g. "apps/server"). Empty string for the root.',
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
      const entries = await getListing(dir);
      return entries
        .map((e) => `${e.isDirectory ? "dir " : "file"} ${e.name}`)
        .join("\n");
    } catch (err) {
      return `Could not list directory: ${err.message}`;
    }
  },
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

/**
 * The registry of tools available to the model.
 */
export const TOOLS = [
  listDirectory,
  readFile,
  createFile,
  createDirectory,
  editFile,
  runPowershell,
];
