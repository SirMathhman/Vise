import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { LlmClient } from "./src/client/llm.ts";
import { tools, toolRunner } from "./src/tools.ts";
import { Session } from "./src/repl/session.ts";
import type {
  ProfileSource,
  NoteSource,
  PreTurnHook,
  PostTurnHook,
} from "./src/repl/session.ts";
import type { Result } from "./src/core/errors.ts";
import { listNotes, formatNoteEntry, initNote } from "./src/notes.ts";
import { formatCompactionFailure, formatError } from "./src/output/format.ts";

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
const session = new Session(client, toolRunner, tools, {
  cwd: process.cwd(),
  context: client,
  modelController: client,
  profileSource: new FileProfileSource(join(process.cwd(), "profiles")),
  noteSource: new FileNoteSource(process.cwd()),
  preTurnHooks,
  postTurnHooks,
});

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let chain = Promise.resolve();
rl.on("line", (line) => {
  if (line.trim() === "") return;
  chain = chain.then(async () => {
    const result = await session.handleLine(line);
    if (result === "exit") {
      rl.close();
      return;
    }
    if (result.ok) {
      console.log(result.value);
      if (result.compactionWarning) {
        console.error(formatCompactionFailure(result.compactionWarning));
      }
    } else {
      console.error(formatError(result.error));
    }
  });
});
