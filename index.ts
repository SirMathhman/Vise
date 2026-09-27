import { createInterface } from "node:readline";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { LlmClient } from "./src/client/llm.ts";
import type { Tool } from "./src/client/llm.ts";
import type { ToolRunner } from "./src/core/engine.ts";
import { Session } from "./src/repl/session.ts";
import { formatError } from "./src/output/format.ts";

const tools: Tool[] = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the files and directories in a given path",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list (default '.')",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file from a given path",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to read",
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
        "Replace the first exact occurrence of old_string in a file with new_string. The file can be of arbitrary length; only the changed portion is provided, so the whole file need not be reproduced. old_string must match exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to edit",
          },
          old_string: {
            type: "string",
            description:
              "Exact literal text to find and replace. Must appear exactly once.",
          },
          new_string: {
            type: "string",
            description:
              "Exact literal text to replace old_string with. May be empty to delete.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
];

const toolRunner: ToolRunner = {
  run(name, args) {
    if (name === "list_directory") {
      try {
        const entries = readdirSync(String(args.path ?? "."));
        return entries.join("\n");
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    if (name === "read_file") {
      try {
        return readFileSync(String(args.path ?? ""), "utf8");
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    if (name === "edit_file") {
      try {
        const path = String(args.path ?? "");
        const old = String(args.old_string ?? "");
        const next = String(args.new_string ?? "");
        const current = readFileSync(path, "utf8");
        const count = current.split(old).length - 1;
        if (count === 0) {
          return `error: old_string not found in ${path}`;
        }
        if (count > 1) {
          return `error: old_string appears ${count} times in ${path}; it must be unique`;
        }
        writeFileSync(path, current.replace(old, next), "utf8");
        return `edited ${path}`;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    return `error: unknown tool ${name}`;
  },
};

const client = new LlmClient();
const session = new Session(client, toolRunner, tools, process.cwd());

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (line.trim() === "") return;
  const result = await session.handleLine(line);
  if (result === "exit") {
    rl.close();
    return;
  }
  if (result.ok) {
    console.log(result.value);
  } else {
    console.error(formatError(result.error));
  }
});
