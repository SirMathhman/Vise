import { streamChat } from "./src/openrouter.ts";
import { runRepl } from "./src/repl/repl.ts";

const MODEL = "anthropic/claude-haiku-5.5";

if (import.meta.main) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("Set OPENROUTER_API_KEY in .env");
    process.exit(1);
  }
  await runRepl(process.stdin, process.stdout, (messages) =>
    streamChat({ apiKey, model: MODEL, messages }),
  );
}
