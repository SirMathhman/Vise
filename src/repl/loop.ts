// The turn loop: glue between input, conversation, client, commands, and
// render.
import * as path from "node:path";
import { persistEnvVar } from "../config/persist.ts";
import type { Config } from "../config.ts";
import { chatCompletionStream, getContextSize } from "../llm/client.ts";
import { listModels } from "../llm/models.ts";
import type { ChatMessage, Usage } from "../llm/types.ts";
import { ensureIndexed } from "../llm/vectors.ts";
import { withNotesIntro } from "../notes.ts";
import { BUILTIN_AGENT, getProfile } from "../profiles.ts";
import { ProcessTracker } from "../tools/process.ts";
import type { ToolContext } from "../tools.ts";
import { runTool, tools } from "../tools.ts";
import { runCommand } from "./commands.ts";
import { compactConversation, TOOLS_DISABLED_NOTICE } from "./compact.ts";
import type { HookCommand } from "./hooks.ts";
import { loadHooks } from "./hooks.ts";
import { createInput } from "./input.ts";
import { runPreSessionCmd } from "./presession.ts";
import {
  createReplyStream,
  renderCommand,
  renderCompactNotice,
  renderError,
  renderHook,
  renderPrompt,
} from "./render.ts";

// Auto-compact once the conversation reaches this fraction of the server's
// context window (see maybeAutoCompact). Chosen to leave headroom for the
// summarization call itself, which needs to fit the existing history plus
// its own reply within the remaining budget.
const AUTO_COMPACT_THRESHOLD = 0.8;

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

// Compacts the conversation in place when usage has crossed
// AUTO_COMPACT_THRESHOLD of the server's context window. Best-effort: a
// failure to fetch the context size or to summarize is swallowed (after a
// stderr warning) rather than interrupting the turn loop, since compaction
// is a housekeeping side effect, not something the user asked for this turn.
// Skipped entirely when the server doesn't report a context size (e.g. a
// router reporting n_ctx: 0), since there's no percentage to compare against.
async function maybeAutoCompact(
  config: Config,
  model: string,
  messages: ChatMessage[],
  activeProfile: string,
  toolsEnabled: boolean,
  usage: Usage,
): Promise<boolean> {
  try {
    const size = await getContextSize(config);
    if (!size || usage.total_tokens / size < AUTO_COMPACT_THRESHOLD) {
      return false;
    }
    const compacted = await compactConversation(
      config,
      model,
      messages,
      activeProfile,
      toolsEnabled,
    );
    messages.splice(0, messages.length, ...compacted);
    return true;
  } catch (err) {
    process.stderr.write(
      `[compact] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

// Drives a single model turn: call the model, handle tool calls, run
// post-turn hooks. Loops until the model stops calling tools or the round
// cap is hit. Errors are caught and rendered; the conversation is left
// intact so the next turn can proceed. When tools are disabled
// (toolsEnabled is false), tool calls still arrive but runTool short-circuits
// them, so the model gets a "disabled" result instead of the tool's work.
// Returns the last round's token usage (for /context), or undefined if the
// server never reported one.
async function runModelTurn(
  config: Config,
  model: string,
  messages: ChatMessage[],
  tracker: ProcessTracker,
  postTurnHooks: HookCommand[],
  activeProfile: string,
  toolsEnabled: boolean,
  activeTools: string[] | undefined,
): Promise<Usage | undefined> {
  // Filter the tools array to only those in the active profile's whitelist.
  // undefined means "all tools" (no whitelist). The filtered array is what
  // the model sees and what subagents inherit via toolCtx.tools.
  const filteredTools = activeTools
    ? tools.filter((t) => activeTools.includes(t.function.name))
    : tools;
  const toolCtx: ToolContext = {
    config,
    model,
    tracker,
    depth: 0,
    tools: filteredTools,
    toolsEnabled,
    dispatch: (name, args, ctx) => runTool(name, args, ctx),
  };
  const MAX_TOOL_ROUNDS = 8;
  // Owns the reply's terminal state (header-once, terminator, idempotency)
  // in the transport. Content deltas are forwarded to write() as they arrive;
  // tool-call rounds usually carry no content, so only the final answer is
  // streamed to the user.
  const replyStream = createReplyStream();
  const onDelta = (delta: string): void => replyStream.write(delta);
  for (let round = 0; ; round++) {
    if (round >= MAX_TOOL_ROUNDS) {
      throw new Error("Stopped after max tool rounds without a final answer");
    }
    const reply = await chatCompletionStream(
      config,
      model,
      messages,
      filteredTools,
      onDelta,
    );
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
    replyStream.end();

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

    return reply.usage;
  }
}

export async function run(config: Config): Promise<void> {
  // The running conversation; every turn appends to it, so each request
  // carries the full history (context) to the model. Seeded with the
  // built-in agent profile's instruction (the CWD system message) so the
  // model can answer environment questions. Using BUILTIN_AGENT.instruction
  // keeps profiles.ts the single source of truth for the default instruction.
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: withNotesIntro(BUILTIN_AGENT.instruction),
    },
  ];

  // The model used for requests. Starts from config and can be changed at
  // runtime with the /model command.
  let model = config.model;

  // The active profile name. Starts from the built-in agent and can be
  // changed at runtime with the /profile command. When it changes, a new
  // system message is appended to the conversation; history is never altered.
  let activeProfile = BUILTIN_AGENT.name;

  // Whether tools are enabled for this session. Starts enabled; the /tools
  // command toggles it. When it changes, a new system message is appended
  // (only when disabled, so the model is told its tools are off); history
  // is never altered. Read at request time and passed into runModelTurn so
  // the switch takes effect on the next turn without rebuilding the client.
  let toolsEnabled = true;

  // The active profile's tool whitelist. undefined means "all tools". Updated
  // when the profile changes. Passed into runModelTurn so the model only sees
  // the whitelisted tool schemas.
  let activeTools: string[] | undefined;

  // The most recent turn's token usage, as reported by the server. undefined
  // until the first turn completes (or if the server never reports usage).
  // Read by /context; updated after every runModelTurn call.
  let lastUsage: Usage | undefined;

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

  // Build or update the vector index before the first turn. Only re-embeds
  // files that changed since the last startup (tracked by mtime + size in
  // .vise/vector.db). Failures are non-fatal: the REPL continues and the
  // semantic_search tool returns an error if the index is unavailable.
  try {
    const summary = await ensureIndexed(config);
    if (summary.indexed > 0 || summary.pruned > 0) {
      process.stderr.write(
        `[index] ${summary.indexed} indexed, ${summary.unchanged} unchanged, ${summary.pruned} pruned, ${summary.skipped} skipped\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[index] ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

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
        toolsEnabled,
        listModels: () => listModels(config),
        persistModel: (name: string) =>
          persistEnvVar(
            path.resolve(process.cwd(), ".env.local"),
            "LLM_MODEL",
            name,
          ),
        lastUsage,
        getContextSize: () => getContextSize(config),
        compact: () =>
          compactConversation(
            config,
            model,
            messages,
            activeProfile,
            toolsEnabled,
          ),
      });
      if (result.setModel) model = result.setModel;
      if (result.setProfile) {
        activeProfile = result.setProfile;
        // Profile change appends a new system message carrying the profile's
        // instruction; it never alters the existing conversation history.
        const profile = getProfile(result.setProfile);
        if (profile) {
          messages.push({
            role: "system",
            content: withNotesIntro(profile.instruction),
          });
          activeTools = profile.tools;
        }
      }
      if (result.setTools !== undefined) {
        toolsEnabled = result.setTools;
        // Turning tools off appends a system message telling the model its
        // tools were just disabled, so it can answer without them on the
        // next turn. Turning them on is silent (nothing for the model to
        // react to). Either way, existing history is never altered.
        if (toolsEnabled === false) {
          messages.push({ role: "system", content: TOOLS_DISABLED_NOTICE });
        }
      }
      if (result.newMessages) {
        // /compact replaces the entire conversation with a fresh, minimal
        // one (profile instruction + summary); the usage figure /context
        // reports is stale the moment that happens.
        messages.splice(0, messages.length, ...result.newMessages);
        lastUsage = undefined;
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
      const usage = await runModelTurn(
        config,
        model,
        messages,
        tracker,
        postTurnHooks,
        activeProfile,
        toolsEnabled,
        activeTools,
      );
      if (usage) {
        lastUsage = usage;
        const compacted = await maybeAutoCompact(
          config,
          model,
          messages,
          activeProfile,
          toolsEnabled,
          usage,
        );
        if (compacted) {
          lastUsage = undefined;
          renderCompactNotice();
        }
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
