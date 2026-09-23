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
  deleteNamedSession,
  listNamedSessions,
  loadNamedSession,
  loadSession,
  newConversation,
  renameNamedSession,
  saveNamedSession,
  saveSession,
} from "../session.ts";
import { ProcessTracker } from "../tools/process.ts";
import type { ToolContext } from "../tools.ts";
import { runTool, tools } from "../tools.ts";
import type { Transport } from "../transport.ts";
import type { CommandResult } from "./commands.ts";
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

// Mutable turn-loop state: the model, the active profile and its tool
// whitelist, whether tools are enabled, the conversation, and the most
// recent turn's usage. Bundled into one object (rather than separate `let`
// locals) so applyCommandResult and applyPostTurnOutcome can mutate it by
// reference without run() threading each field through as a parameter.
type TurnState = {
  model: string;
  activeProfile: string;
  toolsEnabled: boolean;
  activeTools: string[] | undefined;
  messages: ChatMessage[];
  lastUsage: Usage | undefined;
};

// Replaces a conversation's messages in place with a new set, so callers
// holding a reference to the same array (transport renders, session saves)
// observe the replacement immediately. Shared by compaction and by the
// /compact, /load, and /new command results, which all fully replace the
// conversation rather than appending to it.
function replaceMessages(
  messages: ChatMessage[],
  replacement: ChatMessage[],
): void {
  messages.splice(0, messages.length, ...replacement);
}

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

// Runs one hook stage in full: the env-var hook (if configured and allowed
// for the active profile), then every directory-based hook (if allowed),
// in that order. Shared by the pre-session, pre-turn, and post-turn stages,
// which differ only in which command/profile-list/hook-list/renderOn they
// pass in.
async function runHookStage(
  envCmd: string | undefined,
  envProfiles: string[] | undefined,
  envLabel: string,
  hooks: HookCommand[],
  renderOn: "output" | "failure",
  activeProfile: string,
  messages: ChatMessage[],
  transport: Transport,
): Promise<void> {
  if (envCmd && hookAllowed(envProfiles, activeProfile))
    await runHook(envCmd, envLabel, renderOn, messages, transport);
  for (const hook of hooks)
    if (hookAllowed(hook.profiles, activeProfile))
      await runHook(hook.command, hook.name, renderOn, messages, transport);
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
    replaceMessages(messages, compacted);
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
  await runHookStage(
    config.postTurnCmd,
    config.postTurnCmdProfiles,
    "post-turn",
    postTurnHooks,
    "failure",
    activeProfile,
    messages,
    transport,
  );

  return reply.usage;
}

// Applies a built-in command's result to the turn state: model, profile, and
// tools-enabled switches, plus full conversation replacements from /compact,
// /load, and /new. Mutates `state` in place; never touches `userText` or
// transport rendering — the caller renders `result.lines` itself, since the
// modelInput branch (a note/profile one-shot turn) needs to render the same
// way without any state mutation.
function applyCommandResult(result: CommandResult, state: TurnState): void {
  if (result.setModel) state.model = result.setModel;
  if (result.setProfile) {
    state.activeProfile = result.setProfile;
    // Profile change appends a new system message carrying the profile's
    // instruction; it never alters the existing conversation history.
    const profile = getProfile(result.setProfile);
    if (profile) {
      state.messages.push({
        role: "system",
        content: withNotesIntro(profile.instruction),
      });
      state.activeTools = profile.tools;
    }
  }
  if (result.setTools !== undefined) {
    state.toolsEnabled = result.setTools;
    // Turning tools off appends a system message telling the model its
    // tools were just disabled. Turning them on is silent.
    if (state.toolsEnabled === false) {
      state.messages.push({ role: "system", content: TOOLS_DISABLED_NOTICE });
    }
  }
  if (result.newMessages) {
    // /compact replaces conversation history; its usage is stale.
    replaceMessages(state.messages, result.newMessages);
    state.lastUsage = undefined;
  }
  if (result.newSession) {
    // /load and /new replace the conversation and its session settings.
    replaceMessages(state.messages, result.newSession.messages);
    state.activeProfile = result.newSession.activeProfile;
    state.toolsEnabled = result.newSession.toolsEnabled;
    state.activeTools = getProfile(state.activeProfile)?.tools;
    state.lastUsage = undefined;
  }
}

// Records a completed turn's usage and runs auto-compaction when it crosses
// the threshold. A no-op when the server never reported usage. Mutates
// `state.lastUsage` and, on compaction, `state.messages` (via
// maybeAutoCompact) and notifies the transport.
async function applyPostTurnOutcome(
  usage: Usage | undefined,
  config: Config,
  state: TurnState,
  transport: Transport,
): Promise<void> {
  if (!usage) return;
  state.lastUsage = usage;
  const compacted = await maybeAutoCompact(
    config,
    state.model,
    state.messages,
    state.activeProfile,
    state.toolsEnabled,
    usage,
    transport,
  );
  if (compacted) {
    state.lastUsage = undefined;
    transport.compactNotice();
  }
}

// Everything the turn loop needs before its first iteration, produced by
// initializeSession.
type SessionSetup = {
  state: TurnState;
  preTurnHooks: HookCommand[];
  postTurnHooks: HookCommand[];
  tracker: ProcessTracker;
};

// Prepares a fresh or restored session: loads the saved conversation (or
// seeds a fresh one from the built-in agent profile), runs pre-session
// hooks, loads the pre-turn/post-turn hook lists (static for the session),
// creates the process tracker, and builds the semantic-search vector index.
// Indexing failures are non-fatal — logged, not thrown — since it's a
// startup nicety the first turn doesn't depend on; the semantic_search tool
// reports its own error later if the index never became available.
async function initializeSession(
  config: Config,
  transport: Transport,
): Promise<SessionSetup> {
  // Restore the previous session, or fall back to a fresh conversation. The
  // saved session carries the full message history, the active profile name,
  // and the tools-enabled flag. When the file is missing or corrupt, the
  // fallback seeds the built-in agent profile's instruction (the CWD system
  // message) so the model can answer environment questions. Using
  // BUILTIN_AGENT.instruction keeps profiles.ts the single source of truth
  // for the default instruction.
  const session = loadSession();

  // Turn-loop state (see TurnState). `model` starts from config and can be
  // changed at runtime with /model (not part of the saved session: the
  // active model already persists to .env.local). `activeProfile` and
  // `toolsEnabled` are restored from the saved session when present. Both
  // can change at runtime (/profile, /tools); a change appends a new system
  // message to the conversation, never altering existing history.
  // `activeTools` (the active profile's tool whitelist; undefined means "all
  // tools") is derived from the active profile, not saved separately — the
  // profile is the single source of truth for it. `lastUsage` is undefined
  // until the first turn completes (or if the server never reports usage);
  // read by /context.
  const state: TurnState = {
    model: config.model,
    activeProfile: session?.activeProfile ?? BUILTIN_AGENT.name,
    toolsEnabled: session?.toolsEnabled ?? true,
    activeTools: undefined,
    messages: session?.messages ?? [
      { role: "system", content: withNotesIntro(BUILTIN_AGENT.instruction) },
    ],
    lastUsage: undefined,
  };
  state.activeTools = getProfile(state.activeProfile)?.tools;

  // Run pre-session hooks (env var + .hooks/pre-session/ directory) before
  // the first turn. Each hook's output is printed to the user AND appended
  // as a system message so the model sees it as initial context.
  await runHookStage(
    config.preSessionCmd,
    config.preSessionCmdProfiles,
    "pre-session",
    loadHooks("pre-session"),
    "output",
    state.activeProfile,
    state.messages,
    transport,
  );

  // Load hook lists once; the directory structure is static for the session.
  const preTurnHooks = loadHooks("pre-turn");
  const postTurnHooks = loadHooks("post-turn");

  const tracker = new ProcessTracker();

  // Build or update the vector index before the first turn. Only re-embeds
  // files that changed since the last startup (tracked by mtime + size in
  // .vise/vector.db).
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

  return { state, preTurnHooks, postTurnHooks, tracker };
}

export async function run(config: Config, transport: Transport): Promise<void> {
  const { state, preTurnHooks, postTurnHooks, tracker } =
    await initializeSession(config, transport);

  for (;;) {
    // Persist the conversation state at the top of every iteration, so the
    // file on disk always reflects the most recent turn. Saving here (rather
    // than at the end of each branch) means the previous turn's mutations are
    // saved even when the user exits on the very next line (EOF), which
    // otherwise would skip a branch-end save.
    saveSession({
      messages: state.messages,
      activeProfile: state.activeProfile,
      toolsEnabled: state.toolsEnabled,
    });
    transport.prompt();
    const raw = await transport.nextLine();
    const text = (raw ?? "").trim();
    if (text.length === 0) {
      if (raw === "") break;
      continue;
    }
    // Built-in slash commands are handled locally. A matching note or
    // profile name instead turns the line into one model request with that
    // note/profile as context (see runCommand).
    let userText = text;
    if (text.startsWith("/")) {
      const result = await runCommand(text, {
        model: state.model,
        activeProfile: state.activeProfile,
        toolsEnabled: state.toolsEnabled,
        listModels: () => listModels(config),
        persistModel: (name: string) =>
          persistEnvVar(
            path.resolve(process.cwd(), ".env.local"),
            "LLM_MODEL",
            name,
          ),
        lastUsage: state.lastUsage,
        getContextSize: () => getContextSize(config),
        compact: () =>
          compactConversation(
            config,
            state.model,
            state.messages,
            state.activeProfile,
            state.toolsEnabled,
          ),
        saveNamedSession: (name: string) =>
          saveNamedSession(name, {
            messages: state.messages,
            activeProfile: state.activeProfile,
            toolsEnabled: state.toolsEnabled,
          }),
        loadNamedSession: (name: string) => loadNamedSession(name),
        deleteNamedSession: (name: string) => deleteNamedSession(name),
        renameNamedSession: (oldName: string, newName: string) =>
          renameNamedSession(oldName, newName),
        listNamedSessions: () => listNamedSessions(),
        newConversation: (profile: string, tools: boolean) =>
          newConversation(profile, tools),
        createNote: (name: string) => createNote(name),
      });
      if (result.modelInput) {
        userText = result.modelInput;
        transport.command({
          lines: result.lines,
          isError: result.isError,
          sessionNames: result.sessionNames,
        });
      } else {
        applyCommandResult(result, state);
        transport.command({
          lines: result.lines,
          isError: result.isError,
          sessionNames: result.sessionNames,
        });
        continue;
      }
    }
    // Run pre-turn hooks (env var + .hooks/pre-turn/ directory) before every
    // user message. Each hook's output is printed to the user AND appended
    // as a system message so the model sees it as fresh context for each turn.
    await runHookStage(
      config.preTurnCmd,
      config.preTurnCmdProfiles,
      "pre-turn",
      preTurnHooks,
      "output",
      state.activeProfile,
      state.messages,
      transport,
    );

    state.messages.push({ role: "user", content: userText });

    try {
      const usage = await runModelTurn(
        config,
        state.model,
        state.messages,
        tracker,
        postTurnHooks,
        state.activeProfile,
        state.toolsEnabled,
        state.activeTools,
        async (request) => {
          transport.question(request.question, request.type, request.options);
          return transport.nextFreshLine();
        },
        transport,
      );
      await applyPostTurnOutcome(usage, config, state, transport);
    } catch (err) {
      transport.error(err instanceof Error ? err.message : String(err));
    }
  }

  // Loop broke on EOF (or stdin was drained); reap background processes.
  transport.close();
  await tracker.shutdown();
}
