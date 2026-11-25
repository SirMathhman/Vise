import { parseJson } from "common";
import { z } from "zod";
import type { SubagentRunner } from "../chat/reply-context";

/**
 * The name the model uses to call the start-subagent tool.
 */
export const START_SUBAGENT_NAME = "start_subagent";

/**
 * The tool the model may call to hand a task to a subagent. The subagent has the chat's tools, each
 * change still needs approval, and only its final answer comes back.
 */
export const START_SUBAGENT_TOOL = {
  type: "function" as const,
  function: {
    name: START_SUBAGENT_NAME,
    description:
      "Start a subagent on a task and get its final answer. The subagent has the same tools you have, and each change it proposes still needs the user's approval. It sees only the task you write, so include everything it needs. A subagent cannot start another subagent.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task for the subagent, with the context it needs.",
        },
      },
      required: ["task"],
    },
  },
};

const ArgumentsSchema = z.object({ task: z.string().trim().min(1) });

/**
 * Runs a subagent on the task. Only the main reply can start one.
 *
 * @param _root The project root. Unused here.
 * @param argumentsJson The model's arguments: the task.
 * @param _self The model's facts. Unused here.
 * @param subagent Starts the subagent. Absent inside a subagent, which therefore cannot start one.
 * @returns The subagent's final answer, or a message explaining why it did not run.
 */
export async function runStartSubagent(
  _root: string,
  argumentsJson: string,
  _self?: unknown,
  subagent?: SubagentRunner,
): Promise<string> {
  const args = parseJson(ArgumentsSchema, argumentsJson);
  if (!args.ok) {
    return "The arguments were not valid. Use task.";
  }
  if (subagent === undefined) {
    return "A subagent cannot start another subagent.";
  }
  return subagent(args.value.task);
}
