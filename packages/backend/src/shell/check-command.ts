import { parseJson } from "common";
import { z } from "zod";
import { findJob, outputOf } from "../process/jobs";
import { describeFinished } from "./shell";

/**
 * The name the model uses to call the check-command tool.
 */
export const CHECK_COMMAND_NAME = "check_command";

/**
 * The tool the model may call to read a command that moved to the background. It changes nothing.
 */
export const CHECK_COMMAND_TOOL = {
  type: "function" as const,
  function: {
    name: CHECK_COMMAND_NAME,
    description:
      "Read a command that moved to the background, by the id the run_command reply gave. It returns the output so far while the command runs, or its exit code and output once it has finished.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The background command's id." },
      },
      required: ["id"],
    },
  },
};

const CheckArgumentsSchema = z.object({ id: z.string().min(1) });

/**
 * Reads a background command: its output so far, or its result once it has finished.
 *
 * @param argumentsJson The model's arguments: the job id.
 * @returns The command's state and output as text.
 */
export function runCheckCommand(argumentsJson: string): Promise<string> {
  const args = parseJson(CheckArgumentsSchema, argumentsJson);
  if (!args.ok) {
    return Promise.resolve("The arguments were not valid. Use id.");
  }
  const job = findJob(args.value.id);
  if (job === undefined) {
    return Promise.resolve("No background command has that id.");
  }
  if (job.code === undefined) {
    return Promise.resolve(`Still running. Output so far:\n${outputOf(job)}`);
  }
  return Promise.resolve(describeFinished(job));
}
