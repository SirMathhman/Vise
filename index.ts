import { randomBytes } from "node:crypto";
import { readInstructions } from "./src/instructions.ts";
import {
  listModels,
  modelContextWindow,
  streamChat,
} from "./src/openrouter.ts";
import { startSession } from "./src/backend/session.ts";
import type { SessionPorts } from "./src/backend/ports.ts";
import { err, ok, type Result } from "./src/core/result.ts";
import type { Session } from "./src/protocol/protocol.ts";
import { runRepl } from "./src/repl/repl.ts";
import { buildAssets } from "./src/web/server/page.ts";
import { startWebServer } from "./src/web/server/server.ts";
import { killAllJobs } from "./src/tools/jobs.ts";
import {
  loadProfile,
  loadProfileHooks,
  loadProfileTools,
} from "./src/tools/notes/load-profile.ts";
import { runNoteCommand } from "./src/tools/notes/run-note-command.ts";
import { runTool } from "./src/tools/run-tool.ts";
import { hookRunner, readHooks } from "./src/tools/hooks/hooks.ts";
import { sessionStore } from "./src/tools/session-store.ts";
import {
  readToolSettings,
  saveToolSettings,
} from "./src/tools/tool-settings.ts";
import { readModelSetting } from "./src/tools/models/model-settings.ts";
import { selectModel } from "./src/tools/models/select-model.ts";

const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

// The model in use. /model changes it for the requests that follow.
interface ModelSelection {
  model: string;
}

// The settings the session's ports are built from, all read once at startup.
interface PortSetup {
  apiKey: string;
  selection: ModelSelection;
  disabledTools: string[];
  hooks: SessionPorts["hooks"];
  instructions: SessionPorts["instructions"];
}

// Builds every port the session uses. Both the terminal and the browser run the same session.
function sessionPorts(setup: PortSetup): SessionPorts {
  const { apiKey, selection } = setup;
  const root = process.cwd();
  return {
    hooks: setup.hooks,
    reply: (request) =>
      streamChat({ apiKey, model: selection.model, ...request }),
    contextWindow: () => modelContextWindow({ model: selection.model }),
    models: {
      current: () => selection.model,
      list: () => listModels({}),
      select: (name: string) =>
        selectModel({
          root,
          list: () => listModels({}),
          name,
          setModel: (model) => {
            selection.model = model;
          },
        }),
    },
    tools: runTool(root),
    notes: runNoteCommand(root),
    profile: loadProfile(root),
    profileTools: loadProfileTools(root),
    profileHooks: loadProfileHooks(root),
    disabledTools: setup.disabledTools,
    saveDisabledTools: (names) => saveToolSettings(root, names),
    sessions: sessionStore(root),
    instructions: setup.instructions,
  };
}

// The address the browser server uses. web:dev sets both variables, so a restarted server serves the
// same address and the open page can reconnect. Without them, the port and token are picked afresh.
interface WebAddress {
  port: number;
  token: string;
}

function webAddress(): WebAddress {
  const port = Number(process.env.VISE_WEB_PORT ?? 0);
  return {
    port: Number.isInteger(port) ? port : 0,
    token: process.env.VISE_WEB_TOKEN || randomBytes(24).toString("hex"),
  };
}

// Serves the session to a browser on this machine. The URL, with its token, is printed here. Returns
// once the session has ended.
async function runWeb(session: Session): Promise<Result<void>> {
  const assets = await buildAssets();
  if (!assets.ok) return err(assets.error);
  const started = startWebServer({
    session,
    assets: assets.value,
    ...webAddress(),
  });
  if (!started.ok) return err(started.error);
  console.log(`Vise is running in the browser. Open: ${started.value.url}`);
  await started.value.ended;
  started.value.stop();
  return ok(undefined);
}

// Stops every background job, and warns about each one that could not be stopped.
async function stopJobs(): Promise<void> {
  for (const job of await killAllJobs()) {
    console.error(
      `warning: background job ${job.id} (pid ${job.pid}) could not be stopped and may still be running: ${job.command}`,
    );
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
  const selection: ModelSelection = { model: savedModel.value ?? DEFAULT_MODEL };
  // --web serves the session to a browser instead of the terminal.
  const web = process.argv.includes("--web");
  let failed = false;
  try {
    const session = startSession(
      sessionPorts({
        apiKey,
        selection,
        disabledTools: disabled.value,
        hooks: hookRunner(process.cwd(), hookConfig.value),
        instructions,
      }),
    );
    const result = web
      ? await runWeb(session)
      : await runRepl(process.stdin, process.stdout, session);
    if (!result.ok) {
      console.error(`error: ${result.error.message}`);
      failed = true;
    }
  } finally {
    await stopJobs();
  }
  if (failed) process.exit(1);
}
