import type { Tool } from "../../core/engine.ts";

/** One choice of `ask_user`: a short label, or a label with what it means. */
const choiceSchema = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        label: { type: "string", description: "The short choice." },
        description: { type: "string", description: "What choosing it means." },
      },
      required: ["label"],
    },
  ],
};

/** Tools about the agent itself: asking the user, self-report, subagents (handlers: `ask-user.ts`, `self.ts`, `subagent.ts`). */
export const agentTools: Tool[] = [
  {
    type: "function",
    display: { label: "Ask you", icon: "❓" },
    function: {
      name: "ask_user",
      description:
        "Ask the user a question and wait for their answer. Use this when you need clarification or a decision from the user before continuing. You may provide predefined choices the user can pick from, or leave options empty for a free-form question. To ask several things at once, pass `questions`: a list of {question, options, multi_select}, asked one after another, with every answer returned together. The user's reply is returned as the tool result. Example: {\"question\": \"Which scope?\", \"options\": [{\"label\": \"Minimal\", \"description\": \"Only the list of commits\"}, {\"label\": \"Full\", \"description\": \"List, diff and branch switching\"}], \"multi_select\": false}. Every list element is ONE choice (never several joined with newlines), and multi_select is its own argument, never an option.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user. Be specific.",
          },
          options: {
            type: "array",
            items: choiceSchema,
            description:
              "Optional predefined choices to present alongside the question. Each is a short label string, or {label, description} to explain it; one choice per element. The user may also type a free-form answer. Empty array means free-form only.",
          },
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                options: { type: "array", items: choiceSchema },
                multi_select: { type: "boolean" },
              },
              required: ["question"],
            },
            description:
              "Several questions to ask in a row (instead of `question`). Each may have its own options and multi_select. All the answers come back together.",
          },
          multi_select: {
            type: "boolean",
            description:
              "Set true to allow the user to select more than one choice. The user separates selected numbers with commas in their reply. Defaults to false (single selection).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    display: { label: "Check own state", icon: "🪞" },
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
    display: { label: "Update todo list", icon: "📋" },
    function: {
      name: "todo_write",
      description:
        "Keep a todo list for a multi-step task. Each call replaces the whole list; send every item every time, with its current status (pending, in_progress or completed). Keep one item in_progress while you work on it and mark it completed as soon as it is done. The list is shown to the user and saved with the session.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "The step, briefly." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["content", "status"],
            },
            description: "The complete todo list. An empty list clears it.",
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Run helper agent", icon: "🤖" },
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
