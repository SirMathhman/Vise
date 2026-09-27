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
      description: "Write the full contents of a file to a given path",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to write",
          },
          content: {
            type: "string",
            description: "Full new contents of the file",
          },
        },
        required: ["path", "content"],
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
        writeFileSync(
          String(args.path ?? ""),
          String(args.content ?? ""),
          "utf8",
        );
        return `wrote ${String(args.path ?? "")}`;
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
