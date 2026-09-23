// The turn loop: glue between input, conversation, client, commands, and
// render.
import * as path from "node:path";
import { persistEnvVar } from "../config/persist.ts";
import type { Config } from "../config.ts";
import { getContextSize } from "../llm/client.ts";
import { listModels } from "../llm/models.ts";
import { runToolRounds } from "../llm/turns.ts";
import type { AskQuestionRequest, ChatMessage, Usage } from "../llm/types.ts";
import { ensureIndexed } from "../llm/vectors.ts";
import { createNote, withNotesIntro } from "../notes.ts";
import { BUILTIN_AGENT, getProfile } from "../profiles.ts";
import {
  listNamedSessions,
  loadNamedSession,
  loadSession,
  newConversation,
  saveNamedSession,
  saveSession,
} from "../session.ts";
import { ProcessTracker } from "../tools/process.ts";
import type { ToolContext } from "../tools.ts";
import { runTool, tools } from "../tools.ts";
import type { Transport } from "../transport.ts";
import { runCommand } from "./commands.ts";
import { compactConversation, TOOLS_DISABLED_NOTICE } from "./compact.ts";
import type { HookCommand } from "./hooks.ts";
import { loadHooks } from "./hooks.ts";
import { runPreSessionCmd } from "./presession.ts";

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
  transport: Transport,
): Promise<void> {
  const result = await runPreSessionCmd(command);
  const shouldRender =
    renderOn === "output" ? result.output.length > 0 : result.exitCode !== 0;
  if (shouldRender) {
    transport.hook(label, result.output, result.exitCode);
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
  transport: Transport,
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
    transport.log(
      `[compact] ${err instanceof Error ? err.message : String(err)}`,
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
  askQuestion: (request: AskQuestionRequest) => Promise<string>,
  transport: Transport,
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
    askQuestion,
    toolCallObserver: {
      onToolCallStart: (name, args, depth) =>
        transport.toolCallStart(name, args, depth),
      onToolCallEnd: (name, durationMs, status, depth) =>
        transport.toolCallEnd(name, durationMs, status, depth),
    },
    dispatch: (name, args, ctx) => runTool(name, args, ctx),
  };
  // Owns the reply's terminal state (header-once, terminator, idempotency)
  // in the transport. Content deltas are forwarded to write() as they arrive;
  // tool-call rounds usually carry no content, so only the final answer is
  // streamed to the user.
  const replyStream = transport.replyStream();
  let thinking = transport.thinkingIndicator();
  let prefill = transport.prefillIndicator();
  const replyPromise = runToolRounds(
    config,
    model,
    messages,
    filteredTools,
    (name, args) => runTool(name, args, toolCtx),
    {
      onRoundStart: () => {
        thinking = transport.thinkingIndicator();
        prefill = transport.prefillIndicator();
      },
      onDelta: (delta) => {
        prefill.finish();
        thinking.finish();
        replyStream.write(delta);
      },
      onReasoning: (tokens) => {
        prefill.finish();
        thinking.start();
        thinking.report(tokens);
      },
      onPrefill: (processed, total, cache, timeMs) => {
        prefill.start();
        prefill.report(processed, total, cache, timeMs);
      },
      onRoundEnd: () => {
        prefill.finish();
        thinking.finish();
      },
    },
  );
  const reply = await replyPromise.catch((err: unknown) => {
    // Close any partial assistant line without allowing a cleanup failure to
    // replace the model/tool/observer error that caused the turn to fail.
    try {
      replyStream.cancel();
    } catch {
      // Preserve the original failure.
    }
    throw err;
  });
  replyStream.end();

  // Run post-turn hooks (env var + .hooks/post-turn/ directory) after the
  // model's answer. On failure (non-zero exit), the output is printed to
  // the user and appended as a system message for the next turn.
  if (
    config.postTurnCmd &&
    hookAllowed(config.postTurnCmdProfiles, activeProfile)
  )
    await runHook(
      config.postTurnCmd,
      "post-turn",
      "failure",
      messages,
      transport,
    );
  for (const hook of postTurnHooks)
    if (hookAllowed(hook.profiles, activeProfile))
      await runHook(hook.command, hook.name, "failure", messages, transport);

  return reply.usage;
}

export async function run(config: Config, transport: Transport): Promise<void> {
  // Restore the previous session, or fall back to a fresh conversation. The
  // saved session carries the full message history, the active profile name,
  // and the tools-enabled flag. When the file is missing or corrupt, the
  // fallback seeds the built-in agent profile's instruction (the CWD system
  // message) so the model can answer environment questions. Using
  // BUILTIN_AGENT.instruction keeps profiles.ts the single source of truth
  // for the default instruction.
  const session = loadSession();
  const messages: ChatMessage[] = session?.messages ?? [
    { role: "system", content: withNotesIntro(BUILTIN_AGENT.instruction) },
  ];

  // The model used for requests. Starts from config and can be changed at
  // runtime with the /model command. (Not part of the saved session: the
  // active model already persists to .env.local.)
  let model = config.model;

  // The active profile name. Restored from the saved session when present,
  // otherwise the built-in agent. Can be changed at runtime with the
  // /profile command. When it changes, a new system message is appended to
  // the conversation; history is never altered.
  let activeProfile = session?.activeProfile ?? BUILTIN_AGENT.name;

  // Whether tools are enabled for this session. Restored from the saved
  // session when present, otherwise enabled. The /tools command toggles it.
  // When it changes, a new system message is appended (only when disabled,
  // so the model is told its tools are off); history is never altered. Read
  // at request time and passed into runModelTurn so the switch takes effect
  // on the next turn without rebuilding the client.
  let toolsEnabled = session?.toolsEnabled ?? true;

  // The active profile's tool whitelist. undefined means "all tools". Updated
  // when the profile changes. Passed into runModelTurn so the model only sees
  // the whitelisted tool schemas. Derived from the active profile at startup
  // (the profile's own tools field), not saved separately — the profile is
  // the single source of truth for its tool whitelist.
  let activeTools: string[] | undefined = getProfile(activeProfile)?.tools;

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
    await runHook(
      config.preSessionCmd,
      "pre-session",
      "output",
      messages,
      transport,
    );
  for (const hook of preSessionHooks)
    if (hookAllowed(hook.profiles, activeProfile))
      await runHook(hook.command, hook.name, "output", messages, transport);

  // Load hook lists once; the directory structure is static for the session.
  const preTurnHooks = loadHooks("pre-turn");
  const postTurnHooks = loadHooks("post-turn");

  const tracker = new ProcessTracker();

  // Build or update the vector index before the first turn. Only re-embeds
  // files that changed since the last startup (tracked by mtime + size in
  // .vise/vector.db). Failures are non-fatal: the REPL continues and the
  // semantic_search tool returns an error if the index is unavailable.
  try {
    const summary = await ensureIndexed(config);
    if (summary.indexed > 0 || summary.pruned > 0) {
      transport.log(
        `[index] ${summary.indexed} indexed, ${summary.unchanged} unchanged, ${summary.pruned} pruned, ${summary.skipped} skipped`,
      );
    }
  } catch (err) {
    transport.log(
      `[index] ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (;;) {
    // Persist the conversation state at the top of every iteration, so the
    // file on disk always reflects the most recent turn. Saving here (rather
    // than at the end of each branch) means the previous turn's mutations are
    // saved even when the user exits on the very next line (EOF), which
    // otherwise would skip a branch-end save.
    saveSession({ messages, activeProfile, toolsEnabled });
    transport.prompt();
    const raw = await transport.nextLine();
    const text = (raw ?? "").trim();
    if (text.length === 0) {
      if (raw === "") break;
      continue;
    }
    // Built-in slash commands are handled locally. A matching note name
    // instead turns the line into one model request with note context.
    let userText = text;
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
        saveNamedSession: (name: string) =>
          saveNamedSession(name, { messages, activeProfile, toolsEnabled }),
        loadNamedSession: (name: string) => loadNamedSession(name),
        listNamedSessions: () => listNamedSessions(),
        newConversation: (profile: string, tools: boolean) =>
          newConversation(profile, tools),
        createNote: (name: string) => createNote(name),
      });
      if (result.modelInput) {
        userText = result.modelInput;
        transport.command(result);
      } else {
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
          // tools were just disabled. Turning them on is silent.
          if (toolsEnabled === false) {
            messages.push({ role: "system", content: TOOLS_DISABLED_NOTICE });
          }
        }
        if (result.newMessages) {
          // /compact replaces conversation history; its usage is stale.
          messages.splice(0, messages.length, ...result.newMessages);
          lastUsage = undefined;
        }
        if (result.newSession) {
          // /load and /new replace the conversation and its session settings.
          messages.splice(0, messages.length, ...result.newSession.messages);
          activeProfile = result.newSession.activeProfile;
          toolsEnabled = result.newSession.toolsEnabled;
          activeTools = getProfile(activeProfile)?.tools;
          lastUsage = undefined;
        }
        transport.command(result);
        continue;
      }
    }
    // Run pre-turn hooks (env var + .hooks/pre-turn/ directory) before every
    // user message. Each hook's output is printed to the user AND appended
    // as a system message so the model sees it as fresh context for each turn.
    if (
      config.preTurnCmd &&
      hookAllowed(config.preTurnCmdProfiles, activeProfile)
    )
      await runHook(
        config.preTurnCmd,
        "pre-turn",
        "output",
        messages,
        transport,
      );
    for (const hook of preTurnHooks)
      if (hookAllowed(hook.profiles, activeProfile))
        await runHook(hook.command, hook.name, "output", messages, transport);

    messages.push({ role: "user", content: userText });

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
        async (request) => {
          transport.question(request.question, request.type, request.options);
          return transport.nextFreshLine();
        },
        transport,
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
          transport,
        );
        if (compacted) {
          lastUsage = undefined;
          transport.compactNotice();
        }
      }
    } catch (err) {
      transport.error(err instanceof Error ? err.message : String(err));
    }
  }

  // Loop broke on EOF (or stdin was drained); reap background processes.
  transport.close();
  await tracker.shutdown();
  process.exit(0);
}
