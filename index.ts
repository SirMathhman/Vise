import { createInterface } from "node:readline";
import { getBaseUrl, getDefaultModel, loadEnv } from "./src/config";
import { listModels, send } from "./src/client";
import { ask } from "./src/repl";
import type { ReplState } from "./src/types";

async function main(): Promise<void> {
  loadEnv();
  const baseUrl = getBaseUrl();
  const discovered = await listModels();
  if (!discovered.ok) {
    console.error(`Cannot reach ${baseUrl}/v1/models: ${discovered.error}`);
    process.exit(1);
  }
  const available = discovered.models;
  const initialModel = getDefaultModel() ?? available[0];
  if (initialModel === undefined) {
    console.error(`No models reported by ${baseUrl}/v1/models.`);
    process.exit(1);
  }
  if (!available.includes(initialModel)) {
    console.error(
      `VISE_MODEL "${initialModel}" is not in the server's model list:`,
      available.join(", "),
    );
    process.exit(1);
  }
  console.log(`Model: ${initialModel}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const state: ReplState = { history: [], model: initialModel };
  ask(rl, state, { send, listModels });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
