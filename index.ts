import { readInstructions } from "./src/instructions.ts";
import { modelContextWindow, streamChat } from "./src/openrouter.ts";
import { runRepl } from "./src/repl/repl.ts";
import { killAllJobs } from "./src/tools/jobs.ts";
import { loadProfile } from "./src/tools/notes/load-profile.ts";
import { runNoteCommand } from "./src/tools/notes/run-note-command.ts";
import { runTool } from "./src/tools/run-tool.ts";

const MODEL = "anthropic/claude-haiku-5.5";

// Stops every background job, and warns about each one that could not be stopped.
async function stopJobs(): Promise<void> {
  for (const job of await killAllJobs()) {
    console.error(`warning: background job ${job.id} (pid ${job.pid}) could not be stopped and may still be running: ${job.command}`);
  }
}

if (import.meta.main) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("Set OPENROUTER_API_KEY in .env");
    process.exit(1);
  }
  // Ctrl+C stops the jobs and then exits, instead of leaving them running.
  process.once("SIGINT", () => {
    void stopJobs().then(() => process.exit(130));
  });
  // Read once, here, so the session sends the same instructions for its whole length.
  const instructions = await readInstructions(process.cwd());
  let failed = false;
  try {
    const result = await runRepl(process.stdin, process.stdout, {
      reply: (messages, onUsage, onToolCall) => streamChat({ apiKey, model: MODEL, messages, onUsage, onToolCall }),
      contextWindow: () => modelContextWindow({ model: MODEL }),
      tools: runTool(process.cwd()),
      notes: runNoteCommand(process.cwd()),
      profile: loadProfile(process.cwd()),
      instructions,
    });
    if (!result.ok) {
      console.error(`error: ${result.error.message}`);
      failed = true;
    }
  } finally {
    await stopJobs();
  }
  if (failed) process.exit(1);
}
