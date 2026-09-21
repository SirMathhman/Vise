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
        "Run a PowerShell command and return its output. The command runs in the current working directory. Returns stdout, stderr, and the exit code. Use this to run scripts, query the system, or perform file operations that PowerShell handles well.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The PowerShell command or script to execute.",
          },
        },
        required: ["command"],
      },
    },
  },
];

// Executes a tool call and returns its result as a string. Unknown tools
// and read failures are reported as strings so the model can see them.
export function runTool(name: string, args: Record<string, unknown>): string {
  const rawPath = String(args.path ?? "");
  const filePath = path.resolve(process.cwd(), rawPath);
  if (name === "read_file") {
    try {
      return readFileSync(filePath, "utf-8");
    } catch (err) {
      return `Error reading ${rawPath}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }
  if (name === "edit_file") {
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
  }
  if (name === "create_file") {
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
  }
  if (name === "create_directory") {
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
  }
  if (name === "run_powershell") {
    const command = String(args.command ?? "");
    const result = Bun.spawnSync(
      ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    const parts: string[] = [];
    if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
    if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);
    if (result.exitCode !== 0) {
      parts.push(`exit code: ${result.exitCode}`);
    }
    return parts.length > 0 ? parts.join("\n\n") : "(no output)";
  }
  return `Unknown tool: ${name}`;
}
