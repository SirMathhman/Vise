import type { Result } from "common";
import { err, ok, parseJson } from "common";
import { z } from "zod";
import type { Approval } from "../chat/approvals";
import type { BackgroundJob } from "../process/jobs";
import { waitFor } from "../process/jobs";
import { runCaptured } from "../process/run";
import { startSandboxCommand } from "./sandbox";

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
      "Run one bash command in a Linux sandbox and return its exit code and output. The project is at /workspace, which is the working directory, and changes there are written to the real files. Bun and git are installed, and the network is available. The user approves each command before it runs. A command that runs longer than 30 seconds moves to the background, and check_command reads its output. A background command stops after 10 minutes or when the conversation ends.",
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

// How long a background command may run in total. It stops at this limit.
const LIFETIME_MS = 600_000;

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
    apply: () => runSandboxCommand(root, command),
  });
}

/**
 * The result of a command that has finished, as the text the model reads.
 *
 * @param job The finished job.
 * @returns The exit code and output, with a note when the command was stopped at its limit.
 */
export function describeFinished(job: BackgroundJob): string {
  if (job.code === 125) {
    return `The sandbox could not start. Check that podman is running and that the image is built with bun run sandbox:build.
${job.output}`;
  }
  if (job.code === 124) {
    return `Exit code 124 (stopped after ${String(LIFETIME_MS / 1000)} seconds)
${job.output}`;
  }
  return `Exit code ${String(job.code)}
${job.output}`;
}

/**
 * Runs a command in the sandbox. If it is still running after 30 seconds, it keeps running in the
 * background, and the reply names the job to read it with.
 *
 * @param root The project folder to mount.
 * @param command The bash command to run.
 * @returns The finished command's result, or a note naming its background job.
 */
export async function runSandboxCommand(
  root: string,
  command: string,
): Promise<string> {
  const job = startSandboxCommand(root, command, LIFETIME_MS);
  if (await waitFor(job, TIMEOUT_MS)) {
    return describeFinished(job);
  }
  return `This command is still running in the background as ${job.id}. Use check_command with that id to read its output.`;
}
