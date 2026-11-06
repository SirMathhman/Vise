import { readInstructions } from "./src/instructions.ts";
import { listModels, modelContextWindow, streamChat } from "./src/openrouter.ts";
import { runRepl } from "./src/repl/repl.ts";
import { killAllJobs } from "./src/tools/jobs.ts";
import { loadProfile, loadProfileHooks, loadProfileTools } from "./src/tools/notes/load-profile.ts";
import { runNoteCommand } from "./src/tools/notes/run-note-command.ts";
import { runTool } from "./src/tools/run-tool.ts";
import { hookRunner, readHooks } from "./src/tools/hooks/hooks.ts";
import { sessionStore } from "./src/tools/session-store.ts";
import { readToolSettings, saveToolSettings } from "./src/tools/tool-settings.ts";
import { readModelSetting } from "./src/tools/models/model-settings.ts";
import { selectModel } from "./src/tools/models/select-model.ts";

const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

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
  // Read once, here: the tools switched off in the settings file at startup.
  const disabled = await readToolSettings(process.cwd());
  if (!disabled.ok) {
    console.error(`error: ${disabled.error.message}`);
    process.exit(1);
  }
  // Read once, here: the hooks in the hooks file. A file that is not valid stops startup.
  const hookConfig = await readHooks(process.cwd());
  if (!hookConfig.ok) {
    console.error(`error: ${hookConfig.error.message}`);
    process.exit(1);
  }
  // Read once, here: the model chosen with /model in an earlier session, or the default.
  const savedModel = await readModelSetting(process.cwd());
  if (!savedModel.ok) {
    console.error(`error: ${savedModel.error.message}`);
    process.exit(1);
  }
  // The model in use. /model changes it for the requests that follow.
  const selection = { model: savedModel.value ?? DEFAULT_MODEL };
  let failed = false;
  try {
    const result = await runRepl(process.stdin, process.stdout, {
      hooks: hookRunner(process.cwd(), hookConfig.value),
      reply: (messages, onUsage, onToolCall, tools, reasoning, onThinking, onReasoning) =>
        streamChat({
          apiKey,
          model: selection.model,
          messages,
          onUsage,
          onToolCall,
          tools,
          reasoning,
          onThinking,
          onReasoning,
        }),
      contextWindow: () => modelContextWindow({ model: selection.model }),
      models: {
        current: () => selection.model,
        list: () => listModels({}),
        select: (name: string) =>
          selectModel({
            root: process.cwd(),
            list: () => listModels({}),
            name,
            setModel: (model) => {
              selection.model = model;
            },
          }),
      },
      tools: runTool(process.cwd()),
      notes: runNoteCommand(process.cwd()),
      profile: loadProfile(process.cwd()),
      profileTools: loadProfileTools(process.cwd()),
      profileHooks: loadProfileHooks(process.cwd()),
      disabledTools: disabled.value,
      saveDisabledTools: (names) => saveToolSettings(process.cwd(), names),
      sessions: sessionStore(process.cwd()),
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
