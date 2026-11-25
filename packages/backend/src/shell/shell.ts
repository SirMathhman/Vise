import type { Result } from "common";
import { err, ok, parseJson } from "common";
import { z } from "zod";
import type { Approval } from "../chat/approvals";
import { runCaptured } from "../process/run";
import { executeInSandbox } from "./sandbox";

/**
 * The name the model uses to call the shell tool.
 */
export const RUN_COMMAND_NAME = "run_command";

/**
 * The tool the model may call. Any command can be proposed, but the user approves each one
 * before it runs, and it runs in a sandbox container that sees only the project.
 */
export const RUN_COMMAND_TOOL = {
  type: "function" as const,
  function: {
    name: RUN_COMMAND_NAME,
    description:
      "Run one bash command in a Linux sandbox and return its exit code and output. The project is at /workspace, which is the working directory, and changes there are written to the real files. Bun and git are installed, and the network is available. The user approves each command before it runs. A command that runs longer than 30 seconds is stopped.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to run.",
        },
      },
      required: ["command"],
    },
  },
};

const TIMEOUT_MS = 30_000;

const CommandArgumentsSchema = z.object({
  command: z.string().trim().min(1),
});

/**
 * Runs one command directly on this machine, outside the sandbox, in the root. The tool does
 * not use it; it shares the output capture with the sandbox and is kept for local use.
 *
 * @param root The folder the command runs in.
 * @param command The bash command to run.
 * @param timeoutMs How long the command may run.
 * @returns The exit code and output, or an error when the command did not finish.
 */
export async function executeCommand(
  root: string,
  command: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Result<string, string>> {
  const result = await runCaptured(["bash", "-c", command], root, timeoutMs);
  if (!result.ok) {
    return err(result.error);
  }
  return ok(`Exit code ${String(result.value.code)}\n${result.value.output}`);
}

/**
 * Proposes one command for approval. Returns the reason it cannot be proposed as text.
 *
 * @param root The project root.
 * @param argumentsJson The model's arguments, as JSON text.
 * @returns The approval card to show, or the reason the command cannot be proposed.
 */
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
    title: "Run command in the sandbox",
    body: `$ ${command}`,
    apply: async () => {
      const result = await executeInSandbox(root, command, TIMEOUT_MS);
      return result.ok ? result.value : result.error;
    },
  });
}
