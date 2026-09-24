import type { Interface } from "node:readline";
import { BASE_URL, getApiKey } from "./config";
import type { ReplDeps, ReplState, RequestMessage } from "./types";
export type { ReplDeps, ReplState };

// ─── Command handlers ───────────────────────────────────────────────────

function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}\u2026${key.slice(-4)} (${key.length} chars)`;
}

function printEnvInfo(model: string): void {
  const apiKey = getApiKey();
  console.log(`Server:  ${BASE_URL}`);
  console.log(`Model:   ${model}`);
  console.log(`API key: ${apiKey ? maskKey(apiKey) : "not set"}`);
  console.log(
    `Runtime: ${process.version} (${process.platform}/${process.arch})`,
  );
}

async function handleCommand(
  text: string,
  state: ReplState,
  deps: ReplDeps,
): Promise<boolean> {
  if (text.toLowerCase() === "/whoami") {
    printEnvInfo(state.model);
    return true;
  }
  if (
    text.toLowerCase() === "/model" ||
    text.toLowerCase().startsWith("/model ")
  ) {
    const name = text.slice("/model".length).trim();
    const result = await deps.listModels();
    if (!result.ok) {
      console.error(`Cannot list models: ${result.error}`);
    } else if (!name) {
      if (result.models.length === 0) {
        console.log("No models reported by the server.");
      } else {
        for (const id of result.models) {
          console.log(`${id === state.model ? "* " : "  "}${id}`);
        }
      }
    } else if (result.models.includes(name)) {
      state.model = name;
      console.log(`Model: ${state.model}`);
    } else {
      console.error(`Unknown model: ${name}`);
    }
    return true;
  }
  return false;
}

// ─── REPL loop ───────────────────────────────────────────────────────────

export function ask(
  rl: Interface,
  state: ReplState,
  deps: ReplDeps,
): void {
  rl.question("> ", async (line?: string) => {
    const text = (line ?? "").trim();
    if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
      rl.close();
      return;
    }
    if (!text) {
      ask(rl, state, deps);
      return;
    }
    const handled = await handleCommand(text, state, deps);
    if (handled) {
      ask(rl, state, deps);
      return;
    }
    state.history.push({ role: "user", content: text });
    const systemMsg: RequestMessage = {
      role: "system",
      content: `Current working directory: ${process.cwd()}`,
    };
    try {
      const newMessages = await deps.send([systemMsg, ...state.history], state.model);
      for (const m of newMessages) {
        state.history.push(m);
      }
      const last = newMessages[newMessages.length - 1];
      if (last !== undefined) {
        console.log(last.content ?? "");
      }
    } catch (err) {
      state.history.pop();
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    ask(rl, state, deps);
  });
}
