import { createInterface } from "node:readline";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { LlmClient } from "./src/client/llm.ts";
import type { Tool } from "./src/client/llm.ts";
import { runTurn } from "./src/core/engine.ts";
import type { ToolRunner } from "./src/core/engine.ts";
import type { Message } from "./src/core/errors.ts";

const client = new LlmClient();

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

const messages: Message[] = [
  { role: "system", content: `Working directory: ${process.cwd()}` },
];

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (line.trim() === "") return;
  if (line.trim() === "/exit") {
    rl.close();
    return;
  }
  messages.push({ role: "user", content: line });
  const result = await runTurn(client, toolRunner, messages, tools);
  if (result.ok) {
    console.log(result.value);
  } else {
    const err = result.error;
    if (err.kind === "http") {
      console.error(`vise: HTTP ${err.status} from server: ${err.body}`);
    } else if (err.kind === "network") {
      console.error(`vise: ${err.cause}`);
    } else {
      console.error(`vise: ${err.body}`);
    }
  }
});
