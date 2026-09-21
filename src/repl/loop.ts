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
import type { ToolContext } from "../tools.ts";
import { runTool, tools } from "../tools.ts";
import { runCommand } from "./commands.ts";
import type { HookCommand } from "./hooks.ts";
import { loadHooks } from "./hooks.ts";
import { createInput } from "./input.ts";
import { runPreSessionCmd } from "./presession.ts";
import {
  renderCommand,
  renderError,
  renderHook,
  renderPrompt,
  renderReply,
} from "./render.ts";

// Returns true if the hook should run for the given active profile.
// A hook runs when: (a) it has no profile list (runs for all), or
// (b) it has a profile list AND the active profile is in that list.
function hookAllowed(
  profiles: string[] | undefined,
  activeProfile: string,
): boolean {
  if (!profiles || profiles.length === 0) return true;
  return profiles.includes(activeProfile);
}

// Runs a hook command and applies the render/append policy. Pre hooks
// render and append when output is non-empty; post hooks render and append
// when the exit code is non-zero. The exit code is never discarded.
async function runHook(
  command: string,
  label: string,
  renderOn: "output" | "failure",
  messages: ChatMessage[],
): Promise<void> {
  const result = await runPreSessionCmd(command);
  const shouldRender =
    renderOn === "output" ? result.output.length > 0 : result.exitCode !== 0;
  if (shouldRender) {
    renderHook(label, result.output, result.exitCode);
    messages.push({ role: "system", content: result.output });
  }
}

// Drives a single model turn: call the model, handle tool calls, run
// post-turn hooks. Loops until the model stops calling tools or the round
// cap is hit. Errors are caught and rendered; the conversation is left
// intact so the next turn can proceed.
async function runModelTurn(
  config: Config,
  model: string,
  messages: ChatMessage[],
  tracker: ProcessTracker,
  postTurnHooks: HookCommand[],
  activeProfile: string,
): Promise<void> {
  const toolCtx: ToolContext = {
    config,
    model,
    tracker,
    depth: 0,
    tools,
    dispatch: (name, args, ctx) => runTool(name, args, ctx),
  };
  const MAX_TOOL_ROUNDS = 8;
  for (let round = 0; ; round++) {
    if (round >= MAX_TOOL_ROUNDS) {
      throw new Error("Stopped after max tool rounds without a final answer");
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
          content: await runTool(tc.function.name, args, toolCtx),
        });
      }
      continue;
    }
    const answer = reply.content;
    if (answer.length > 0)
      messages.push({ role: "assistant", content: answer });
    renderReply(answer);

    // Run post-turn hooks (env var + .hooks/post-turn/ directory) after
    // the model's answer. On failure (non-zero exit), the output is
    // printed to the user AND appended as a system message so the model
    // can see it on the next turn. A failing command with empty output
    // still triggers the failure path (the exit code is never discarded).
    if (
      config.postTurnCmd &&
      hookAllowed(config.postTurnCmdProfiles, activeProfile)
    )
      await runHook(config.postTurnCmd, "post-turn", "failure", messages);
    for (const hook of postTurnHooks)
      if (hookAllowed(hook.profiles, activeProfile))
        await runHook(hook.command, hook.name, "failure", messages);

    break;
  }
}

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

  // The model used for requests. Starts from config and can be changed at
  // runtime with the /model command.
  let model = config.model;

  // The active profile name. Starts from the built-in Agent and can be
  // changed at runtime with the /profile command. When it changes, a new
  // system message is appended to the conversation; history is never altered.
  let activeProfile = BUILTIN_AGENT.name;

  // Run pre-session hooks (env var + .hooks/pre-session/ directory) before
  // the first turn. Each hook's output is printed to the user AND appended
  // as a system message so the model sees it as initial context.
  const preSessionHooks = loadHooks("pre-session");
  if (
    config.preSessionCmd &&
    hookAllowed(config.preSessionCmdProfiles, activeProfile)
  )
    await runHook(config.preSessionCmd, "pre-session", "output", messages);
  for (const hook of preSessionHooks)
    if (hookAllowed(hook.profiles, activeProfile))
      await runHook(hook.command, hook.name, "output", messages);

  // Load hook lists once; the directory structure is static for the session.
  const preTurnHooks = loadHooks("pre-turn");
  const postTurnHooks = loadHooks("post-turn");

  const input = createInput();
  const { nextLine, close } = input;
  const tracker = new ProcessTracker();

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
    // Run pre-turn hooks (env var + .hooks/pre-turn/ directory) before every
    // user message. Each hook's output is printed to the user AND appended
    // as a system message so the model sees it as fresh context for each turn.
    if (
      config.preTurnCmd &&
      hookAllowed(config.preTurnCmdProfiles, activeProfile)
    )
      await runHook(config.preTurnCmd, "pre-turn", "output", messages);
    for (const hook of preTurnHooks)
      if (hookAllowed(hook.profiles, activeProfile))
        await runHook(hook.command, hook.name, "output", messages);

    messages.push({ role: "user", content: text });

    try {
      await runModelTurn(
        config,
        model,
        messages,
        tracker,
        postTurnHooks,
        activeProfile,
      );
    } catch (err) {
      renderError(err instanceof Error ? err.message : String(err));
    }
  }

  // Loop broke on EOF (or stdin was drained); reap background processes.
  close();
  await tracker.shutdown();
  process.exit(0);
}
