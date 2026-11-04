import { modelContextWindow, streamChat } from "./src/openrouter.ts";
import { runRepl } from "./src/repl/repl.ts";
import { killAllJobs } from "./src/tools/jobs.ts";
import { runTool } from "./src/tools/run-tool.ts";

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
    (messages, onUsage, onToolCall) => streamChat({ apiKey, model: MODEL, messages, onUsage, onToolCall }),
    () => modelContextWindow({ model: MODEL }),
    runTool(process.cwd()),
  );
  for (const job of await killAllJobs()) {
    console.error(`warning: background job ${job.id} (pid ${job.pid}) could not be stopped and may still be running: ${job.command}`);
  }
  if (!result.ok) {
    console.error(`error: ${result.error.message}`);
    process.exit(1);
  }
}
