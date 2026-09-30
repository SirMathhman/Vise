import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
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
} from "./src/repl/session.ts";
import type { Result, PromptProgress } from "./src/core/errors.ts";
import {
  listNotes,
  formatNoteEntry,
  initNote,
  validName,
} from "./src/notes.ts";
import { formatCompactionFailure, formatError } from "./src/output/format.ts";
import { red, dim, cyan } from "./src/output/color.ts";
import { renderLine } from "./src/output/markdown.ts";
import { buildInitialTree } from "./src/fs-tree.ts";

/** The placeholder body for a newly initialized profile. */
const PROFILE_TEMPLATE =
  "TODO: describe the persona or instructions for this profile";

/**
 * Edge implementation of ProfileSource backed by a `profiles/` directory of
 * `.md` files. This is the sole owner of profile I/O; the session only asks
 * for names and text and performs no fs access itself (invariant #2).
 */
class FileProfileSource implements ProfileSource {
  constructor(private readonly dir: string) {}

  async listProfiles(): Promise<Result<string[]>> {
    if (!existsSync(this.dir)) return { ok: true, value: [] };
    const names = readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
    return { ok: true, value: names };
  }

  async loadProfile(name: string): Promise<Result<string>> {
    const file = join(this.dir, `${name}.md`);
    if (!existsSync(file)) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: `profile '${name}' not found. Run '/profile' to see available profiles.`,
        },
      };
    }
    return { ok: true, value: readFileSync(file, "utf-8") };
  }

  async initProfile(name: string): Promise<Result<string>> {
    const file = join(this.dir, `${name}.md`);
    if (!validName(name)) {
      return {
        ok: false,
        error: { kind: "malformed", body: `invalid profile name '${name}'` },
      };
    }
    if (existsSync(file)) {
      return {
        ok: false,
        error: { kind: "malformed", body: `profile '${name}' already exists` },
      };
    }
    mkdirSync(this.dir, { recursive: true });
    const body = PROFILE_TEMPLATE.replace(/\s+$/, "") + "\n";
    writeFileSync(file, body, "utf-8");
    return { ok: true, value: name };
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

// Live progress counters. The prompt counter shows how many prompt tokens
// are being computed during the silent prefill (llama.cpp `return_progress`);
// the thinking counter counts reasoning_content deltas. Neither prints the
// underlying text. Both reset at the start of each turn.
let promptActive = false;
let lastProcessed = 0;
let thinkingCount = 0;
let thinkingActive = false;
let contentWritten = false;
// Markdown line-buffer state: buffers tokens until a newline is hit, then
// renders the completed line via `renderLine`. Reset at the start of each
// turn.
let mdLineBuffer = "";
let mdInFence = false;

const onPromptProgress = (progress: PromptProgress) => {
  if (progress.processed >= progress.total) {
    // Prefill finished; clear the counter line for the content that follows.
    if (promptActive) {
      promptActive = false;
      process.stdout.write("\n");
    }
    return;
  }
  // Dim the live counter. The overwrite width must be computed from the
  // raw (un-dimmed) text: ANSI bytes are not part of the display width.
  const text = dim(`prompt: ${progress.processed}/${progress.total}`);
  if (promptActive) {
    const prev = `prompt: ${lastProcessed}/${progress.total}`;
    process.stdout.write("\r" + " ".repeat(prev.length + 1) + "\r" + text);
  } else {
    if (contentWritten) {
      process.stdout.write("\n");
    }
    promptActive = true;
    process.stdout.write(text);
  }
  lastProcessed = progress.processed;
};

const onThinking = (_token: string) => {
  thinkingCount++;
  // Dim the live counter; overwrite width from the raw (un-dimmed) text.
  const text = dim(`thinking: ${thinkingCount}`);
  if (thinkingActive) {
    const prev = `thinking: ${thinkingCount - 1}`;
    process.stdout.write("\r" + " ".repeat(prev.length + 1) + "\r" + text);
  } else {
    if (contentWritten) {
      process.stdout.write("\n");
    }
    thinkingActive = true;
    process.stdout.write(text);
  }
};

const onToken = (token: string) => {
  if (promptActive) {
    promptActive = false;
    process.stdout.write("\n");
  }
  if (thinkingActive) {
    thinkingActive = false;
    process.stdout.write("\n");
  }
  contentWritten = true;
  mdLineBuffer += token;
  // Split out completed lines and render each with markdown styling.
  let nl: number;
  while ((nl = mdLineBuffer.indexOf("\n")) !== -1) {
    const line = mdLineBuffer.slice(0, nl);
    mdLineBuffer = mdLineBuffer.slice(nl + 1);
    const [styled, newInFence] = renderLine(line, mdInFence);
    mdInFence = newInFence;
    process.stdout.write(styled + "\n");
  }
};

const profileSource = new FileProfileSource(join(process.cwd(), "profiles"));

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
    onToken,
    onThinking,
    onPromptProgress,
  ),
});

const initialTree = buildInitialTree(process.cwd());
const session = new Session(client, toolRunner, tools, {
  cwd: process.cwd(),
  context: client,
  modelController: client,
  toolController,
  profileSource,
  noteSource: new FileNoteSource(process.cwd()),
  preTurnHooks,
  postTurnHooks,
  onToken,
  onThinking,
  onPromptProgress,
  initialMessage: `Here is the initial directory structure of the working directory:\n${initialTree}`,
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
    promptActive = false;
    lastProcessed = 0;
    thinkingCount = 0;
    thinkingActive = false;
    contentWritten = false;
    mdLineBuffer = "";
    mdInFence = false;
    const result = await session.handleLine(line);
    if (result === "exit") {
      rl.close();
      return;
    }
    if (result.ok) {
      // A streamed turn already wrote its reply token-by-token; flush any
      // partial line still buffered and emit the closing newline. Unstreamed
      // results (slash commands, etc.) are printed whole via console.log.
      if (result.streamed) {
        if (mdLineBuffer.length > 0) {
          const [styled, newInFence] = renderLine(mdLineBuffer, mdInFence);
          mdInFence = newInFence;
          mdLineBuffer = "";
          process.stdout.write(styled + "\n");
        }
      } else {
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
