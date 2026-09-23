import type { Tool, ToolContext } from "../llm/types.ts";

export const ask_user_schema: Tool = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "Ask the user one plain-text question and wait for their answer. Use when clarification or a user decision is needed. The user response is returned as the tool result.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The single question to present to the user.",
        },
      },
      required: ["question"],
    },
  },
};

export const ask_user = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> => {
  const question = String(args.question ?? "").trim();
  if (!question) return "ask_user requires a non-empty question.";
  if (!ctx.askQuestion) return "ask_user is unavailable in this context.";
  const answer = await ctx.askQuestion(question);
  if (answer.length === 0) {
    return "The user input closed before an answer was received.";
  }
  return `User response: ${answer}`;
};
