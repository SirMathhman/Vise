import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// Endpoint of the already-running OpenAI-compatible LLM server (llama.cpp).
const BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:8080";
const MODEL = process.env.LLM_MODEL ?? "local";
// Sent as a Bearer token only when set (the server may run without a key).
const API_KEY = process.env.LLM_API_KEY;

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
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
        },
        body: JSON.stringify({
          model: MODEL,
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
