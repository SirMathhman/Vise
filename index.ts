import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// Endpoint of the already-running OpenAI-compatible LLM server (llama.cpp).
const BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:8080";
const MODEL = process.env.LLM_MODEL ?? "local";
// Sent as a Bearer token only when set (the server may run without a key).
const API_KEY = process.env.LLM_API_KEY;

// The model used for requests. Starts from config and can be changed at
// runtime with the /model command.
let model = MODEL;

// Headers shared by every request to the server.
const authHeaders = (): Record<string, string> =>
  API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Every "line" event is pushed onto a buffer as it arrives, so piped lines
// that land while a fetch is in flight are not lost.
const lines: string[] = [];
let closed = false;
rl.on("line", (line) => {
  lines.push(line);
});
rl.on("close", () => {
  closed = true;
});
process.on("SIGINT", () => {
  console.log("\nBye.");
  rl.close();
});

// Resolves with the next buffered line, or "" once input has closed and no
// lines remain.
const nextLine = (): Promise<string> => {
  if (lines.length > 0) return Promise.resolve(lines.shift() ?? "");
  if (closed) return Promise.resolve("");
  return new Promise((resolve) => {
    const done = (value: string) => {
      rl.removeListener("line", onLine);
      rl.removeListener("close", onClose);
      resolve(value);
    };
    const onLine = () => done(lines.shift() ?? "");
    const onClose = () => done("");
    rl.on("line", onLine);
    rl.on("close", onClose);
  });
};

// --- Model selection ----------------------------------------------------
// The server reports the models it can serve at GET /v1/models, each with a
// load status. /model lists them and switches the active one.
type ModelInfo = { id: string; loaded: boolean };

// Fetches the models the server can serve. Throws on transport/HTTP errors.
async function listModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${BASE_URL}/v1/models`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as {
    data?: { id?: string; status?: { value?: string } }[];
  };
  const models: ModelInfo[] = [];
  for (const m of data.data ?? []) {
    if (typeof m.id === "string") {
      models.push({ id: m.id, loaded: m.status?.value === "loaded" });
    }
  }
  return models;
}

// Rewrites LLM_MODEL in .env.local so the choice survives a restart. The
// file is created if it does not exist.
function persistModel(name: string): void {
  const envPath = path.resolve(process.cwd(), ".env.local");
  let contents = "";
  try {
    contents = readFileSync(envPath, "utf-8");
  } catch {
    contents = "";
  }
  const line = `LLM_MODEL=${name}`;
  let updated: string;
  if (/^LLM_MODEL=.*$/m.test(contents)) {
    updated = contents.replace(/^LLM_MODEL=.*$/m, line);
  } else if (contents.length === 0) {
    updated = `${line}\n`;
  } else {
    updated = `${contents.replace(/\n*$/, "")}\n${line}\n`;
  }
  writeFileSync(envPath, updated, "utf-8");
}

// Handles a slash command. Returns true when the line was a command, so the
// caller knows not to send it to the model.
async function handleCommand(text: string): Promise<boolean> {
  const [command, ...rest] = text.split(/\s+/);
  if (command !== "/model") {
    console.log(`\nUnknown command: ${command}. Try /model.\n`);
    return true;
  }
  let models: ModelInfo[];
  try {
    models = await listModels();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`error: could not list models: ${detail}`);
    return true;
  }
  const name = rest.join(" ").trim();
  if (name.length === 0) {
    console.log("\nAvailable models:");
    for (const m of models) {
      const marks = [m.id === model ? "current" : "", m.loaded ? "loaded" : ""];
      const suffix = marks.filter(Boolean).join(", ");
      console.log(`  ${m.id}${suffix ? ` (${suffix})` : ""}`);
    }
    console.log("");
    return true;
  }
  if (!models.some((m) => m.id === name)) {
    console.error(`error: unknown model: ${name}`);
    console.error("Available models:");
    for (const m of models) console.error(`  ${m.id}`);
    return true;
  }
  model = name;
  try {
    persistModel(name);
    console.log(`\nmodel> ${name} (saved to .env.local)\n`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`\nmodel> ${name} (not saved: ${detail})\n`);
  }
  return true;
}

// --- Tool calling -------------------------------------------------------
// The agent can call tools. Currently only read_file is available, which
// reads a file from disk (relative to the working directory) and returns
// its text content.
type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

const tools = [
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
];

// Executes a tool call and returns its result as a string. Unknown tools
// and read failures are reported as strings so the model can see them.
function runTool(name: string, args: Record<string, unknown>): string {
  if (name === "read_file") {
    const rawPath = String(args.path ?? "");
    try {
      return readFileSync(path.resolve(process.cwd(), rawPath), "utf-8");
    } catch (err) {
      return `Error reading ${rawPath}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }
  return `Unknown tool: ${name}`;
}

// The running conversation; every turn appends to it, so each request
// carries the full history (context) to the model. Seeded with a system
// message carrying the CWD so the model can answer environment questions.
const messages: ChatMessage[] = [
  {
    role: "system",
    content: `The current working directory is: ${process.cwd()}`,
  },
];

for (;;) {
  process.stdout.write("you> ");
  const raw = await nextLine();
  const text = (raw ?? "").trim();
  if (text.length === 0) {
    if (closed) break;
    continue;
  }
  // Slash commands are handled locally and never reach the model.
  if (text.startsWith("/")) {
    await handleCommand(text);
    continue;
  }
  messages.push({ role: "user", content: text });

  try {
    // The model may call tools any number of times before producing a final
    // answer, so loop until it stops calling tools. Cap the rounds to avoid
    // an unbounded loop if the model keeps calling tools.
    const MAX_TOOL_ROUNDS = 8;
    for (let round = 0; ; round++) {
      if (round >= MAX_TOOL_ROUNDS) {
        throw new Error("Stopped after max tool rounds without a final answer");
      }
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          model,
          messages,
          tools,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`HTTP ${res.status}: ${detail}`);
      }
      const data = (await res.json()) as {
        choices?: {
          message?: {
            content?: string | null;
            tool_calls?: ToolCall[];
          };
        }[];
      };
      const msg = data.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        // Append the assistant's tool-call message, then each tool's result,
        // and loop so the model can produce a final answer.
        messages.push({
          role: "assistant",
          content: msg?.content ?? null,
          tool_calls: toolCalls,
        });
        for (const tc of toolCalls) {
          const args = JSON.parse(tc.function.arguments) as Record<
            string,
            unknown
          >;
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: runTool(tc.function.name, args),
          });
        }
        continue;
      }
      const answer = msg?.content ?? "";
      if (answer.length > 0)
        messages.push({ role: "assistant", content: answer });
      console.log(`\nassistant> ${answer || "(empty response)"}\n`);
      break;
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Loop broke on EOF (or stdin was drained); nothing left to do.
process.exit(0);
