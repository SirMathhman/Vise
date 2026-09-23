import type { AskQuestionRequest, Tool, ToolContext } from "../llm/types.ts";

export const ask_user_schema: Tool = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "Ask the user one question and wait for their answer. Use type 'freeform' for an open-ended response, 'multiple_choice' for one answer from options, or 'multiple_select' when several options may apply. Choice questions also accept free-form text or additions; the user can answer naturally without special syntax. The answer is returned as the tool result.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The single question to present to the user.",
        },
        type: {
          type: "string",
          enum: ["freeform", "multiple_choice", "multiple_select"],
          description:
            "Question style: freeform, multiple_choice, or multiple_select.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "Answer options for multiple_choice or multiple_select; omit for freeform.",
        },
      },
      required: ["question", "type"],
      oneOf: [
        {
          properties: { type: { enum: ["freeform"] } },
          not: { required: ["options"] },
        },
        {
          properties: {
            type: { enum: ["multiple_choice", "multiple_select"] },
          },
          required: ["options"],
        },
      ],
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
  const type = args.type;
  if (
    type !== "freeform" &&
    type !== "multiple_choice" &&
    type !== "multiple_select"
  ) {
    return "ask_user type must be freeform, multiple_choice, or multiple_select.";
  }
  const rawOptions = args.options;
  let request: AskQuestionRequest = { question, type };
  if (type === "freeform") {
    if (rawOptions !== undefined) {
      return "ask_user options are only valid for multiple_choice or multiple_select.";
    }
  } else {
    if (
      !Array.isArray(rawOptions) ||
      rawOptions.length < 2 ||
      rawOptions.some((option) => typeof option !== "string" || !option.trim())
    ) {
      return "ask_user choice questions require at least two non-empty string options.";
    }
    request = { question, type, options: rawOptions as string[] };
  }
  const answer = await ctx.askQuestion(request);
  if (answer.length === 0) {
    return "The user input closed before an answer was received.";
  }
  return `User response: ${answer}`;
};
