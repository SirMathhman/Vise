import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { LlmClient } from "./src/client/llm.ts";
import { tools, toolController, createToolRunner } from "./src/tools.ts";
import { makeSubagentHandler } from "./src/tools/subagent.ts";
import { Session } from "./src/repl/session.ts";
import type {
  ProfileSource,
  NoteSource,
  PreTurnHook,
  PostTurnHook,
  SessionSource,
  SavedSession,
} from "./src/repl/session.ts";
import type { Message, Result } from "./src/core/errors.ts";
import { listNotes, formatNoteEntry, initNote } from "./src/notes.ts";
import { listProfiles, readProfile, initProfile } from "./src/profiles.ts";
import {
  saveAutoSession,
  saveNamedSession,
  loadSession,
  listSessions,
} from "./src/sessions.ts";
import { formatCompactionFailure, formatError } from "./src/output/format.ts";
import { red, dim, cyan } from "./src/output/color.ts";
import { StreamDisplay } from "./src/driver/stream.ts";
import { buildInitialTree } from "./src/fs-tree.ts";

/**
 * Edge implementation of ProfileSource backed by a `profiles/` directory of
 * `.md` files. Thin adapter over the shared profile-file I/O in
 * `src/profiles.ts` (invariant #2: edge owns I/O; the session only asks for
 * names and text).
 */
class FileProfileSource implements ProfileSource {
  constructor(private readonly base: string) {}

  async listProfiles(): Promise<Result<string[]>> {
    return { ok: true, value: listProfiles(this.base) };
  }

  async loadProfile(name: string): Promise<Result<string>> {
    const text = readProfile(this.base, name);
    if (text === undefined) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: `profile '${name}' not found. Run '/profile' to see available profiles.`,
        },
      };
    }
    return { ok: true, value: text };
  }

  async initProfile(name: string): Promise<Result<string>> {
    try {
      initProfile(this.base, name);
      return { ok: true, value: name };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

/**
 * Edge implementation of PreTurnHook and PostTurnHook. Runs a configured shell
 * command and returns its combined stdout/stderr output (or error text).
 * The command is read from `.viserc.json` in the working directory.
 */
class ShellHook implements PreTurnHook, PostTurnHook {
  private readonly command: string;

  constructor(command: string) {
    this.command = command;
  }

  async run(): Promise<string> {
    try {
      const res = await new Promise<{
        status: number;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const proc = spawn("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          this.command,
        ]);
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
        }, 30_000);
        proc.stdout.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        proc.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        proc.on("close", (status) => {
          clearTimeout(timer);
          if (timedOut) {
            resolve({ status: -1, stdout, stderr });
          } else {
            resolve({ status: status ?? -1, stdout, stderr });
          }
        });
        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const body = [res.stdout.trim(), res.stderr.trim()]
        .filter((s) => s !== "")
        .join("\n");
      if (res.status !== 0) {
        return `hook error (exit code ${res.status}):\n${body}`.trim();
      }
      return body;
    } catch (err) {
      return `hook error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * Edge implementation of NoteSource backed by the `notes/` directory.
 * Lists every note with its one-line summary and creates new notes. This is
 * the user's view of the same store the model edits via tools.
 */
class FileNoteSource implements NoteSource {
  constructor(private readonly base: string) {}

  async listNotes(): Promise<Result<string[]>> {
    const notes = listNotes(this.base);
    return {
      ok: true,
      value: notes.map(formatNoteEntry),
    };
  }

  async initNote(name: string): Promise<Result<string>> {
    try {
      initNote(this.base, name);
      return { ok: true, value: name };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

/**
 * Edge implementation of SessionSource backed by a `sessions/` directory of
 * `.json` files. Thin adapter over the shared session I/O in
 * `src/sessions.ts` (invariant #2: edge owns I/O; the session only asks for
 * messages and profile names).
 */
class FileSessionSource implements SessionSource {
  constructor(private readonly base: string) {}

  async save(
    messages: Message[],
    activeProfile: string | undefined,
  ): Promise<Result<void>> {
    return saveAutoSession(this.base, messages, activeProfile);
  }

  async saveNamed(
    name: string,
    messages: Message[],
    activeProfile: string | undefined,
  ): Promise<Result<void>> {
    return saveNamedSession(this.base, name, messages, activeProfile);
  }

  async load(name: string): Promise<Result<SavedSession>> {
    return loadSession(this.base, name);
  }

  async list(): Promise<Result<string[]>> {
    return { ok: true, value: listSessions(this.base) };
  }
}

/**
 * Read hook commands from `.viserc.json` if present.
 *
 * Each hook key (`preTurnCommand`, `postTurnCommand`) accepts either a
 * single command string or an array of command strings. An array produces
 * one hook per entry; all hooks of a kind run in parallel each turn.
 */
function loadHookCommands(): { pre?: string[]; post?: string[] } {
  const configPath = join(process.cwd(), ".viserc.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    const result: { pre?: string[]; post?: string[] } = {};
    const pre = config.preTurnCommand;
    const post = config.postTurnCommand;
    if (typeof pre === "string") {
      result.pre = [pre];
    } else if (Array.isArray(pre) && pre.every((c) => typeof c === "string")) {
      result.pre = pre;
    }
    if (typeof post === "string") {
      result.post = [post];
    } else if (
      Array.isArray(post) &&
      post.every((c) => typeof c === "string")
    ) {
      result.post = post;
    }
    return result;
  } catch {
    // Malformed config: fall back to no hooks.
  }
  return {};
}

const hookCommands = loadHookCommands();
const preTurnHooks = (hookCommands.pre ?? []).map((cmd) => new ShellHook(cmd));
const postTurnHooks = (hookCommands.post ?? []).map(
  (cmd) => new ShellHook(cmd),
);

const client = new LlmClient();

const display = new StreamDisplay();

const profileSource = new FileProfileSource(process.cwd());
const sessionSource = new FileSessionSource(process.cwd());

// The subagent handler needs the ToolRunner for recursion, and the runner
// needs the handler. Break the cycle with a lazily-resolving structural
// runner: its `run` closure reads `toolRunner` at dispatch time (after the
// const below is initialized), so `run_subagent` dispatches back through the
// real runner and any subagent tool call routes through the composed handler.
const toolRunner = createToolRunner({
  run_subagent: makeSubagentHandler(
    client,
    profileSource,
    process.cwd(),
    {
      run: (name: string, args: Record<string, unknown>) =>
        toolRunner.run(name, args),
    },
    tools,
    display.onToken,
    display.onThinking,
    display.onPromptProgress,
  ),
});

/**
 * Read the project's `AGENTS.md` agent-instructions file from the working
 * directory. Returns its full text, or an empty string when the file is
 * absent or unreadable (auto-load is best-effort; a missing file must not
 * prevent startup). Edge module: performs `node:fs` I/O (invariant #2).
 */
function loadAgentsMd(dir: string): string {
  try {
    return readFileSync(join(dir, "AGENTS.md"), "utf8");
  } catch {
    return "";
  }
}

const initialTree = buildInitialTree(process.cwd());
const agentsMd = loadAgentsMd(process.cwd());
const initialMessage =
  `Here is the initial directory structure of the working directory:\n${initialTree}` +
  (agentsMd !== ""
    ? `\n\nHere are the agent instructions for this project (AGENTS.md):\n${agentsMd}`
    : "");
const session = new Session(client, toolRunner, tools, {
  cwd: process.cwd(),
  context: client,
  modelController: client,
  toolController,
  profileSource,
  noteSource: new FileNoteSource(process.cwd()),
  sessionSource,
  preTurnHooks,
  postTurnHooks,
  onToken: display.onToken,
  onThinking: display.onThinking,
  onPromptProgress: display.onPromptProgress,
  initialMessage,
});

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// Colored prompt marker. With `terminal: false`, readline does not manage
// the echo position; the OS terminal echoes typed characters, so writing
// the marker here (and after every turn) places it at the start of the line
// the user is about to type on.
process.stdout.write(cyan("> "));

let chain = Promise.resolve();
rl.on("line", (line) => {
  if (line.trim() === "") return;
  chain = chain.then(async () => {
    display.beginTurn();
    const result = await session.handleLine(line);
    if (result === "exit") {
      rl.close();
      return;
    }
    if (result.ok) {
      // A streamed turn already wrote its reply token-by-token; flush any
      // partial line still buffered and emit the closing newline. Unstreamed
      // results (slash commands, etc.) are printed whole via console.log.
      const streamed = !!result.streamed;
      display.finish(streamed);
      if (!streamed) {
        console.log(result.value);
      }
      if (result.compactionWarning) {
        console.error(red(formatCompactionFailure(result.compactionWarning)));
      }
    } else {
      console.error(red(formatError(result.error)));
    }
    process.stdout.write(cyan("> "));
  });
});
