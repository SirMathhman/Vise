import type { Result } from "common";
import { err, ok, parseJson } from "common";
import { z } from "zod";
import type { Approval } from "../chat/approvals";

export const RUN_COMMAND_NAME = "run_command";

// The tool the model may call. Any command can be proposed, but the user approves each one
// before it runs.
export const RUN_COMMAND_TOOL = {
  type: "function" as const,
  function: {
    name: RUN_COMMAND_NAME,
    description:
      "Run one shell command in the project root and return its exit code and output. The user approves each command before it runs. A command that runs longer than 30 seconds is stopped.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to run.",
        },
      },
      required: ["command"],
    },
  },
};

const TIMEOUT_MS = 30_000;
const MAX_CHARS = 20_000;

// Environment names that look like credentials are not passed on to the command.
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

const CommandArgumentsSchema = z.object({
  command: z.string().trim().min(1),
});

// The environment a command runs with: the backend's, minus anything that looks like a credential.
function commandEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CREDENTIAL_NAME.test(name)) {
      env[name] = value;
    }
  }
  return env;
}

function startCommand(root: string, command: string) {
  return Bun.spawn(["bash", "-c", command], {
    cwd: root,
    env: commandEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

// Runs one command in the root and returns its exit code and output as text, cut to MAX_CHARS.
// A command that runs past the timeout is stopped, and the reply does not wait for its output.
export async function executeCommand(
  root: string,
  command: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Result<string, string>> {
  let proc: ReturnType<typeof startCommand>;
  try {
    proc = startCommand(root, command);
  } catch {
    return err("The command could not be started.");
  }
  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const state = {
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  const timedOut = new Promise<undefined>((resolve) => {
    state.timer = setTimeout(() => {
      proc.kill();
      resolve(undefined);
    }, timeoutMs);
  });
  const result = await Promise.race([finished, timedOut]);
  clearTimeout(state.timer);
  if (result === undefined) {
    return err(
      `The command was stopped after ${String(timeoutMs / 1000)} seconds.`,
    );
  }
  const [stdout, stderr, code] = result;
  const output = `stdout:\n${stdout}\nstderr:\n${stderr}`;
  const body =
    output.length > MAX_CHARS
      ? `${output.slice(0, MAX_CHARS)}\n... cut at ${String(MAX_CHARS)} characters`
      : output;
  return ok(`Exit code ${String(code)}\n${body}`);
}

// Proposes one command for approval. Returns the reason it cannot be proposed as text.
export function runRunCommand(
  root: string,
  argumentsJson: string,
): Promise<string | Approval> {
  const args = parseJson(CommandArgumentsSchema, argumentsJson);
  if (!args.ok) {
    return Promise.resolve("The arguments were not valid. Use command.");
  }
  const { command } = args.value;
  return Promise.resolve({
    title: "Run command",
    body: `$ ${command}`,
    apply: async () => {
      const result = await executeCommand(root, command);
      return result.ok ? result.value : result.error;
    },
  });
}
