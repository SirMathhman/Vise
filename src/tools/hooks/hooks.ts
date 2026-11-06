import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { HookPoint, HookRunner } from "../../core/compaction.ts";
import { err, ok, type Result } from "../../core/result.ts";
import { runPowershell } from "../run-powershell.ts";

// The hooks file, in the working directory. Each point lists the commands to run, in order.
const HOOKS_FILE = join(".vise", "hooks.json");

const HookConfigSchema = z.object({
  sessionStart: z.array(z.string()).optional(),
  sessionEnd: z.array(z.string()).optional(),
  turnStart: z.array(z.string()).optional(),
  turnEnd: z.array(z.string()).optional(),
});

export interface HookConfig {
  sessionStart: string[];
  sessionEnd: string[];
  turnStart: string[];
  turnEnd: string[];
}

// Reads the hooks file. A missing file has no hooks. A file that is not JSON, or does not list
// commands as strings, is an error and nothing runs.
export async function readHooks(root: string): Promise<Result<HookConfig>> {
  let text: string;
  try {
    text = await readFile(join(root, HOOKS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ok({ sessionStart: [], sessionEnd: [], turnStart: [], turnEnd: [] });
    }
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(new Error(`${HOOKS_FILE} is not JSON`));
  }
  const parsed = HookConfigSchema.safeParse(value);
  if (!parsed.success) return err(new Error(`${HOOKS_FILE} must list the commands of each point as strings`));
  const config = parsed.data;
  return ok({
    sessionStart: config.sessionStart ?? [],
    sessionEnd: config.sessionEnd ?? [],
    turnStart: config.turnStart ?? [],
    turnEnd: config.turnEnd ?? [],
  });
}

// The exit code runPowershell reports on the last line, or undefined when there is none.
function exitCodeOf(text: string): number | undefined {
  const match = /\[exit code (-?\d+)\]\s*$/.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

// Runs the commands of one point in order. The output of each is kept, and the first command that
// fails, exits non-zero, or is still running after the timeout stops the rest and is returned as an error.
export function hookRunner(root: string, config: HookConfig): HookRunner {
  return async (point: HookPoint, profile: string[] = []): Promise<Result<string>> => {
    let output = "";
    for (const command of [...config[point], ...profile]) {
      const result = await runPowershell(root, command);
      if (!result.ok) return err(new Error(`hook ${command} could not run: ${result.error.message}`));
      const exitCode = exitCodeOf(result.value);
      if (exitCode !== 0 || result.value.includes("[still running")) {
        return err(new Error(`hook ${command} failed:\n${result.value}`));
      }
      output = `${output}${output === "" ? "" : "\n\n"}[hook ${command}]\n${result.value}`;
    }
    return ok(output);
  };
}
