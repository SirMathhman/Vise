import { config } from "../../config.ts";
import { noAudit, type AuditSink } from "@vise/core";
import { matchesTool, type PreToolVerdict, type ToolHookEntry, type ToolHooks } from "@vise/core";
import { spawnPowerShell } from "../shell.ts";

/** Exit code a pre-tool hook uses to veto the call. */
export const BLOCK_EXIT_CODE = 2;

/** Longest argument/result text put into an environment variable (the full payload is on stdin). */
const ENV_CAP = 8000;
/** Longest hook output shown to the model. */
const OUTPUT_CAP = 4000;

interface HookRun {
  /** Process exit code, or -1 for a timeout or a spawn failure. */
  status: number;
  output: string;
}

const cap = (text: string, limit: number): string =>
  text.length > limit
    ? `${text.slice(0, limit)}... (${text.length - limit} more characters)`
    : text;

/** Run one hook command with the call described in its environment and on its standard input. */
async function runHook(
  command: string,
  cwd: string | undefined,
  env: Record<string, string>,
  stdin: string,
): Promise<HookRun> {
  try {
    const { proc, record } = spawnPowerShell(command, cwd, { env, stdin });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, config.toolHookTimeoutMs);
    const status = await new Promise<number>((resolve, reject) => {
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve(timedOut ? -1 : (code ?? -1));
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const output = [record.stdout.trim(), record.stderr.trim()].filter((s) => s !== "").join("\n");
    return {
      status,
      output: timedOut
        ? `hook timed out after ${config.toolHookTimeoutMs} ms\n${output}`.trim()
        : output,
    };
  } catch (err) {
    return {
      status: -1,
      output: `hook error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The tool hooks of a session: shell commands run before a tool call (which
 * may veto it) and after it (whose output goes back to the model with the
 * result). The entry lists are the live ones of the `HookStore`, read at every
 * call, so edits apply at once. Hooks are started here, never through the
 * `ToolRunner`, so a hook cannot cause hooks.
 */
export class ShellToolHooks implements ToolHooks {
  constructor(
    private readonly preEntries: ToolHookEntry[],
    private readonly postEntries: ToolHookEntry[],
    private readonly cwd: string | undefined,
    private readonly audit: AuditSink = noAudit,
  ) {}

  async pre(
    name: string,
    category: string | undefined,
    args: Record<string, unknown>,
    depth: number,
  ): Promise<PreToolVerdict> {
    const runs = await this.runAll(
      "pre_tool",
      this.preEntries,
      name,
      category,
      args,
      undefined,
      depth,
    );
    const veto = runs.find((r) => r.status === BLOCK_EXIT_CODE);
    if (!veto) return {};
    return { blocked: veto.output || "no reason given" };
  }

  async post(
    name: string,
    category: string | undefined,
    args: Record<string, unknown>,
    result: string,
    depth: number,
  ): Promise<string> {
    const runs = await this.runAll(
      "post_tool",
      this.postEntries,
      name,
      category,
      args,
      result,
      depth,
    );
    return runs
      .filter((r) => r.output.trim() !== "")
      .map((r) => `[post-tool hook: ${cap(r.output, OUTPUT_CAP)}]`)
      .join("\n");
  }

  private async runAll(
    phase: "pre_tool" | "post_tool",
    entries: ToolHookEntry[],
    name: string,
    category: string | undefined,
    args: Record<string, unknown>,
    result: string | undefined,
    depth: number,
  ): Promise<HookRun[]> {
    const matching = entries.filter((e) => matchesTool(e, name, category));
    if (matching.length === 0) return [];
    const argsJson = JSON.stringify(args);
    const ok = result === undefined ? undefined : !result.startsWith("error:");
    const stdin = JSON.stringify({ phase, tool: name, args, result, ok, depth });
    const env: Record<string, string> = {
      VISE_TOOL_NAME: name,
      VISE_TOOL_ARGS: cap(argsJson, ENV_CAP),
      VISE_TOOL_DEPTH: String(depth),
    };
    if (result !== undefined) {
      env.VISE_TOOL_OK = ok ? "1" : "0";
      env.VISE_TOOL_RESULT = cap(result, ENV_CAP);
    }
    return Promise.all(
      matching.map(async (entry) => {
        const started = performance.now();
        const run = await runHook(entry.command, this.cwd, env, stdin);
        this.audit.record({
          kind: "hook_run",
          phase,
          command: entry.command,
          ms: performance.now() - started,
          output: run.output,
          tool: name,
          status: run.status,
        });
        return run;
      }),
    );
  }
}
