// The turn loop: glue between input, conversation, client, commands, and
// render.
import * as path from "node:path";
import { persistEnvVar } from "../config/persist.ts";
import type { Config } from "../config.ts";
import { chatCompletion } from "../llm/client.ts";
import { listModels } from "../llm/models.ts";
import type { ChatMessage } from "../llm/types.ts";
import { BUILTIN_AGENT, getProfile } from "../profiles.ts";
import { ProcessTracker } from "../tools/process.ts";
import { runTool, tools } from "../tools.ts";
import { runCommand } from "./commands.ts";
import { createInput } from "./input.ts";
import { runPreSessionCmd } from "./presession.ts";
import {
  renderCommand,
  renderError,
  renderPostTurn,
  renderPreSession,
  renderPreTurn,
  renderPrompt,
  renderReply,
} from "./render.ts";

export async function run(config: Config): Promise<void> {
  // The running conversation; every turn appends to it, so each request
  // carries the full history (context) to the model. Seeded with the
  // built-in Agent profile's instruction (the CWD system message) so the
  // model can answer environment questions. Using BUILTIN_AGENT.instruction
  // keeps profiles.ts the single source of truth for the default instruction.
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: BUILTIN_AGENT.instruction,
    },
  ];

  // Run the pre-session command (if configured) before the first turn. Its
  // output is printed to the user AND appended as a system message so the
  // model sees it as initial context.
  if (config.preSessionCmd) {
    const result = await runPreSessionCmd(config.preSessionCmd);
    if (result.output.length > 0) {
      renderPreSession(result.output, result.exitCode);
      messages.push({ role: "system", content: result.output });
    }
  }

  const input = createInput();
  const { nextLine, close } = input;
  const tracker = new ProcessTracker();

  // The model used for requests. Starts from config and can be changed at
  // runtime with the /model command.
  let model = config.model;

  // The active profile name. Starts from the built-in Agent and can be
  // changed at runtime with the /profile command. When it changes, a new
  // system message is appended to the conversation; history is never altered.
  let activeProfile = BUILTIN_AGENT.name;

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
        activeProfile,
        listModels: () => listModels(config),
        persistModel: (name: string) =>
          persistEnvVar(
            path.resolve(process.cwd(), ".env.local"),
            "LLM_MODEL",
            name,
          ),
      });
      if (result.setModel) model = result.setModel;
      if (result.setProfile) {
        activeProfile = result.setProfile;
        // Profile change appends a new system message carrying the profile's
        // instruction; it never alters the existing conversation history.
        const profile = getProfile(result.setProfile);
        if (profile) {
          messages.push({ role: "system", content: profile.instruction });
        }
      }
      renderCommand(result);
      continue;
    }
    // Run the pre-turn command (if configured) before every user message.
    // Its output is printed to the user AND appended as a system message so
    // the model sees it as fresh context for each turn.
    if (config.preTurnCmd) {
      const result = await runPreSessionCmd(config.preTurnCmd);
      if (result.output.length > 0) {
        renderPreTurn(result.output, result.exitCode);
        messages.push({ role: "system", content: result.output });
      }
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
              content: await runTool(tc.function.name, args, tracker),
            });
          }
          continue;
        }
        const answer = reply.content;
        if (answer.length > 0)
          messages.push({ role: "assistant", content: answer });
        renderReply(answer);

        // Run the post-turn command (if configured) after the model's answer.
        // On failure (non-zero exit), the output is printed to the user AND
        // appended as a system message so the model can see it on the next
        // turn. A failing command with empty output still triggers the
        // failure path (the exit code is never discarded).
        if (config.postTurnCmd) {
          const result = await runPreSessionCmd(config.postTurnCmd);
          if (result.exitCode !== 0) {
            renderPostTurn(result.output, result.exitCode);
            messages.push({ role: "system", content: result.output });
          }
        }

        break;
      }
    } catch (err) {
      renderError(err instanceof Error ? err.message : String(err));
    }
  }

  // Loop broke on EOF (or stdin was drained); reap background processes.
  close();
  await tracker.shutdown();
  process.exit(0);
}
