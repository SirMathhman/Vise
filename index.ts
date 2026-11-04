import { modelContextWindow, streamChat } from "./src/openrouter.ts";
import { runRepl } from "./src/repl/repl.ts";

const MODEL = "anthropic/claude-haiku-5.5";

if (import.meta.main) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("Set OPENROUTER_API_KEY in .env");
    process.exit(1);
  }
  const result = await runRepl(
    process.stdin,
    process.stdout,
    (messages, onUsage) => streamChat({ apiKey, model: MODEL, messages, onUsage }),
    () => modelContextWindow({ model: MODEL }),
  );
  if (!result.ok) {
    console.error(`error: ${result.error.message}`);
    process.exit(1);
  }
}
