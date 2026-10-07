import type { Tool } from "../../core/engine.ts";

/** Tools about the agent itself: asking the user, self-report, subagents (handlers: `ask-user.ts`, `self.ts`, `subagent.ts`). */
export const agentTools: Tool[] = [
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a question and wait for their answer. Use this when you need clarification or a decision from the user before continuing. You may provide predefined choices the user can pick from, or leave options empty for a free-form question. The user's reply is returned as the tool result.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user. Be specific.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional predefined choices to present alongside the question. The user may also type a free-form answer. Empty array means free-form only.",
          },
          multi_select: {
            type: "boolean",
            description:
              "Set true to allow the user to select more than one choice. The user separates selected numbers with commas in their reply. Defaults to false (single selection).",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self",
      description:
        "Report the agent's own state: the inference backend, the active model, the working directory, the current context-window fill, the active profile, and the pre/post-turn hook commands. Take no arguments; call it when you need to confirm which model and profile you are acting as, or how much context is in use.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_subagent",
      description:
        "Run a subagent: a fresh, isolated conversation with its own profile, to perform a task and return its final result. The subagent can use all the same tools (including run_subagent) as you. Use it to delegate a self-contained sub-task.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "The task to hand to the subagent. Be specific: what to do and what to return.",
          },
          profile: {
            type: "string",
            description:
              "Profile name for the subagent's instructions. Use 'default' for the built-in general profile, or the name of a profile in profiles/.",
          },
        },
        required: ["task", "profile"],
      },
    },
  },
];
