import { readInstructions } from "./src/instructions.ts";
import { buildProvider } from "./src/providers/provider.ts";
import { effectiveProviders, readScopedServers, scopedProvidersStore } from "./src/providers/config.ts";
import { startSession } from "./src/backend/session.ts";
import type { SessionPorts } from "./src/backend/ports.ts";
import { err, ok, type Provider, type Result } from "./src/core/messages.ts";
import type { Session } from "./src/protocol/protocol.ts";
import { runRepl } from "./src/repl/repl.ts";
import { buildAssets } from "./src/web/server/page.ts";
import { type WebAddress, takeWebAddress } from "./src/web/server/address.ts";


import { startWebServer, type WebAssets } from "./src/web/server/server.ts";
import { killAllJobs } from "./src/tools/process/jobs.ts";
import { type McpRegistry, noServers, startMcpServers } from "./src/tools/mcp/registry.ts";
import { scopedMcpStore } from "./src/tools/mcp/config.ts";
import { undoStore } from "./src/tools/undo/undo-files.ts";
import { pickFolder } from "./src/tools/process/folder-picker.ts";
import type { FileText, UndoStore } from "./src/core/messages.ts";
import { toolNames } from "./src/core/tools.ts";
import {
  loadProfile,
  loadProfileHooks,
  loadProfileTools,
} from "./src/tools/notes/load-profile.ts";
import { runNoteCommand } from "./src/tools/notes/run-note-command.ts";
import { runTool } from "./src/tools/run-tool.ts";
import { listChildren } from "./src/tools/files/list-files.ts";
import { readWholeVersioned, writeWholeTextIfUnchanged } from "./src/tools/files/read-file.ts";
import { hookRunner, readHooks } from "./src/tools/hooks/hooks.ts";
import { sessionStore } from "./src/tools/session-store.ts";
import { resumeStore } from "./src/tools/resume/resume-store.ts";
import { scopedProfileStore } from "./src/tools/notes/profile-store.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import {
  readToolSettings,
  saveToolSettings,
} from "./src/tools/tool-settings.ts";
import { readModelSetting } from "./src/tools/models/model-settings.ts";
import { selectModel } from "./src/tools/models/select-model.ts";


// The MCP servers that started, stopped on every exit path. Empty until startup starts them.
// The home folder is the global scope: its .vise/mcp.json and .vise/providers.json, and its notes/profile folder,
// are laid out like a project folder's, and a project's entry with the same name replaces a global one.
const GLOBAL_FOLDER = homedir();
let servers: McpRegistry = noServers();

// The model in use. /model changes it for the requests that follow.
interface ModelSelection {
  model: string;
}

// The settings the session's ports are built from, all read once at startup.
interface PortSetup {
  provider: Provider;
  // The folder the session works in.
  folder: string;
  selection: ModelSelection;
  disabledTools: string[];
  // Every tool the session may offer, built-in and from the MCP servers.
  allTools: string[];
  mcp: McpRegistry;
  // The file changes /undo can revert, kept in memory for this session.
  undo: UndoStore;
  hooks: SessionPorts["hooks"];
  instructions: SessionPorts["instructions"];
}

// Builds every port the session uses. Both the terminal and the browser run the same session.
function sessionPorts(setup: PortSetup): SessionPorts {
  const { provider, selection } = setup;
  const root = setup.folder;
  const extraTools = setup.mcp.specs();
  return {
    hooks: setup.hooks,
    reply: (request) =>
      provider.reply({ model: selection.model, extraTools, ...request }),
    contextWindow: () => provider.contextWindow(selection.model),
    models: {
      current: () => selection.model,
      list: () => provider.listModels(),
      select: (name: string) =>
        selectModel({
          root,
          list: () => provider.listModels(),
          name,
          setModel: (model) => {
            selection.model = model;
          },
        }),
    },
    tools: runTool(root, setup.mcp, setup.undo),
    undo: setup.undo,
    allTools: setup.allTools,
    notes: runNoteCommand(root),
    profile: loadProfile(root, GLOBAL_FOLDER),
    profileTools: loadProfileTools(root, setup.allTools, GLOBAL_FOLDER),
    profileHooks: loadProfileHooks(root, GLOBAL_FOLDER),
    disabledTools: setup.disabledTools,
    saveDisabledTools: (names) => saveToolSettings(root, names),
    sessions: sessionStore(root),
    // Kept in the user's home folder, not the project, so a repository cannot ship a conversation to resume.
    resume: resumeStore(join(homedir(), ".vise", "resume"), root),
    profiles: scopedProfileStore(root, GLOBAL_FOLDER, setup.allTools),
    mcp: scopedMcpStore(root, GLOBAL_FOLDER, setup.mcp.statuses()),
    providers: scopedProvidersStore(root, GLOBAL_FOLDER),
    folder: root,
    tree: (path) => listChildren(root, path),
    fileText: (path) => readWholeVersioned(root, path),
    saveFile: (path, text, base) => saveWithUndo(root, setup.undo, { path, text, base }),
    instructions: setup.instructions,
  };
}

// The address the browser server uses. web:dev sets both variables, so a restarted server serves the
// same address and the open page can reconnect. Without them, the port and token are picked afresh.
// Serves the session to a browser on this machine. The URL, with its token, is printed here. Returns
// once the session has ended.
async function runWeb(
  session: Session,
  address: WebAddress,
  changeFolderTo: (folder: string) => Promise<Result<Session>>,
  embedded: WebAssets | undefined,
): Promise<Result<void>> {
  // The folder dialog opens on this machine, as the page is served from here.
  const assets = await buildAssets(embedded);
  if (!assets.ok) return err(assets.error);
  const started = startWebServer({
    session,
    assets: assets.value,
    changeFolder: changeFolderTo,
    checkFolder: folderOf,
    pickFolder,
    ...address,
  });
  if (!started.ok) return err(started.error);
  console.log(`Vise is running in the browser. Open: ${started.value.url}`);
  await started.value.ended;
  started.value.stop();
  return ok(undefined);
}

// Stops every MCP server and background job. Jobs that could not be stopped are named.
async function stopEverything(): Promise<void> {
  await servers.stop();
  await stopJobs();
}

// Stops every background job, and warns about each one that could not be stopped.
async function stopJobs(): Promise<void> {
  for (const job of await killAllJobs()) {
    console.error(
      `warning: background job ${job.id} (pid ${job.pid}) could not be stopped and may still be running: ${job.command}`,
    );
  }
}

// Starts a session in a folder. The folder's instructions, hooks, servers, and tool settings are read from it,
// so this runs again for each folder the session moves to. A failure stops anything it started.
async function openSession(provider: Provider, selection: ModelSelection, folder: string): Promise<Result<Session>> {
  // Read once, here, so the session sends the same instructions for its whole length.
  const instructions = await readInstructions(folder);
  // Read once, here: the hooks in the hooks file. A file that is not valid stops the start.
  const hookConfig = await readHooks(folder);
  if (!hookConfig.ok) return err(hookConfig.error);
  // Read once, here: the MCP servers in the servers file start now, and their tools are offered with the
  // built-in ones. A broken servers file stops the start; a server that fails is only reported.
  const started = await startMcpServers(folder, GLOBAL_FOLDER);
  if (!started.ok) return err(started.error);
  servers = started.value;
  for (const problem of servers.problems()) console.error(`warning: MCP ${problem}`);
  const allTools = [...toolNames, ...servers.specs().map((spec) => spec.function.name)];
  // Read once, here: the tools switched off in the settings file at startup.
  const disabled = await readToolSettings(folder, allTools);
  if (!disabled.ok) {
    await servers.stop();
    return err(disabled.error);
  }
  return ok(
    startSession(
      sessionPorts({
        provider,
        selection,
        folder,
        disabledTools: disabled.value,
        allTools,
        mcp: servers,
        undo: undoStore(folder),
        hooks: hookRunner(folder, hookConfig.value),
        instructions,
      }),
    ),
  );
}

// Writes a page's edit to a file, if the file still holds the version it was based on, and records it for /undo as its
// own turn. The bytes are read before the change, so a failure to read the file is reported and nothing is written.
interface PageEdit {
  path: string;
  text: string;
  base: string;
}

async function saveWithUndo(root: string, undo: UndoStore, edit: PageEdit): Promise<Result<FileText>> {
  undo.startTurn();
  let outcome: Result<FileText> = err(new Error("the file was not written"));
  await undo.around(edit.path, async () => {
    outcome = await writeWholeTextIfUnchanged(root, edit.path, edit.text, edit.base);
    return outcome.ok ? "saved" : outcome.error.message;
  });
  return outcome;
}

// The full path of a folder that exists, or the reason it cannot be used. Checked before a session is ended.
async function folderOf(folder: string): Promise<Result<string>> {
  const target = resolve(folder);
  const info = await stat(target).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return err(new Error(`${target} is not a folder`));
  // A folder that cannot be listed cannot be worked in, so it is refused before anything stops.
  try {
    await readdir(target);
  } catch {
    return err(new Error(`${target} cannot be read`));
  }
  return ok(target);
}

// Moves the session to another folder. The current MCP servers and background jobs stop first, then the
// process moves to the folder and the session starts there. The page's history and model are kept.
async function changeFolder(folder: string, provider: Provider, selection: ModelSelection): Promise<Result<Session>> {
  const checked = await folderOf(folder);
  if (!checked.ok) return err(checked.error);
  const target = checked.value;
  await stopEverything();
  try {
    process.chdir(target);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  return openSession(provider, selection, target);
}

// Runs Vise. The Windows build (build/exe/server-entry.ts, written by scripts/build-exe.ts) passes the page's files it embeds.
export async function main(embedded?: WebAssets): Promise<void> {
  // The providers listed in the folder's and the home folder's .vise/providers.json, read once here.
  const servers = await readScopedServers(process.cwd(), GLOBAL_FOLDER);
  if (!servers.ok) {
    console.error(servers.error.message);
    process.exit(1);
  }
  const built = buildProvider(effectiveProviders(servers.value));
  if (!built.ok) {
    console.error(built.error.message);
    process.exit(1);
  }
  const provider = built.value;
  // Taken from the environment before anything starts. Child processes get a copy without the key and
  // the token (src/tools/child-env.ts).
  const address = takeWebAddress(process.env);
  // Ctrl+C stops the jobs and then exits, instead of leaving them running.
  process.once("SIGINT", () => {
    void stopEverything().then(() => process.exit(130));
  });
  // Read once, here: the model chosen with /model in an earlier session, or the default. It is kept when the
  // folder changes, so a change of folder keeps the model.
  const savedModel = await readModelSetting(process.cwd());
  if (!savedModel.ok) {
    console.error(`error: ${savedModel.error.message}`);
    process.exit(1);
  }
  const selection: ModelSelection = { model: savedModel.value ?? provider.defaultModel };
  // --web serves the session to a browser instead of the terminal.
  const web = process.argv.includes("--web");
  let failed = false;
  try {
    const opened = await openSession(provider, selection, process.cwd());
    if (!opened.ok) {
      console.error(`error: ${opened.error.message}`);
      failed = true;
    } else {
      const result = web
        ? await runWeb(opened.value, address, (folder) => changeFolder(folder, provider, selection), embedded)
        : await runRepl(process.stdin, process.stdout, opened.value);
      if (!result.ok) {
        console.error(`error: ${result.error.message}`);
        failed = true;
      }
    }
  } finally {
    await stopEverything();
  }
  if (failed) process.exit(1);
}

if (import.meta.main) await main();
