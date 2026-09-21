// The turn loop: glue between input, conversation, client, commands, and
// render.
import * as path from "node:path";
import { persistEnvVar } from "../config/persist.ts";
import type { Config } from "../config.ts";
import { chatCompletion } from "../llm/client.ts";
import { listModels } from "../llm/models.ts";
import type { ChatMessage } from "../llm/types.ts";
import { runTool, tools } from "../tools.ts";
import { runCommand } from "./commands.ts";
import { createInput } from "./input.ts";
import {
  renderCommand,
  renderError,
  renderPrompt,
  renderReply,
} from "./render.ts";

export async function run(config: Config): Promise<void> {
  // The running conversation; every turn appends to it, so each request
  // carries the full history (context) to the model. Seeded with a system
  // message carrying the CWD so the model can answer environment questions.
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `The current working directory is: ${process.cwd()}`,
    },
  ];

  const input = createInput();
  const { nextLine, close } = input;

  // The model used for requests. Starts from config and can be changed at
  // runtime with the /model command.
  let model = config.model;

  for (;;) {
    renderPrompt();
    const raw = await nextLine();
    const text = (raw ?? "").trim();
    if (text.length === 0) {
      if (raw === "") break;
      continue;
    }
    // Slash commands are handled locally and never reach the model.
    if (text.startsWith("/")) {
      const result = await runCommand(text, {
        model,
        listModels: () => listModels(config),
        persistModel: (name: string) =>
          persistEnvVar(
            path.resolve(process.cwd(), ".env.local"),
            "LLM_MODEL",
            name,
          ),
      });
      if (result.setModel) model = result.setModel;
      renderCommand(result);
      continue;
    }
    messages.push({ role: "user", content: text });

    try {
      // The model may call tools any number of times before producing a final
      // answer, so loop until it stops calling tools. Cap the rounds to avoid
      // an unbounded loop if the model keeps calling tools.
      const MAX_TOOL_ROUNDS = 8;
      for (let round = 0; ; round++) {
        if (round >= MAX_TOOL_ROUNDS) {
          throw new Error(
            "Stopped after max tool rounds without a final answer",
          );
        }
        const reply = await chatCompletion(config, model, messages, tools);
        const toolCalls = reply.toolCalls;
        if (toolCalls.length > 0) {
          // Append the assistant's tool-call message, then each tool's
          // result, and loop so the model can produce a final answer.
          messages.push({
            role: "assistant",
            content: reply.content || null,
            tool_calls: toolCalls,
          });
          for (const tc of toolCalls) {
            const args = JSON.parse(tc.function.arguments) as Record<
              string,
              unknown
            >;
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: await runTool(tc.function.name, args),
            });
          }
          continue;
        }
        const answer = reply.content;
        if (answer.length > 0)
          messages.push({ role: "assistant", content: answer });
        renderReply(answer);
        break;
      }
    } catch (err) {
      renderError(err instanceof Error ? err.message : String(err));
    }
  }

  // Loop broke on EOF (or stdin was drained); nothing left to do.
  close();
  process.exit(0);
}
