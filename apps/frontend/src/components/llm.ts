import {
  executeLlmTool,
  type LlmMessage,
  type LlmTool,
  type LlmToolCall,
  type LlmUsage,
  listLlmModels,
  runShellCommand,
  type ShellCommandResult,
  sendLlmMessage,
  streamLlmMessage,
} from "../api/client.js";
import { llmToolDefinitions } from "../llm/tools.js";
import {
  type AskCardHandle,
  type AskQuestion,
  renderAskQuestionsCard,
} from "./askQuestionsCard.js";
import {
  type ChatMessage,
  type ConversationStore,
  createConversationStore,
} from "./conversations.js";
import {
  MessageView,
  type SubagentStep,
  toolCallLabel,
} from "./messageView.js";
import {
  renderProfileToolList,
  renderSubagentProfileList,
} from "./profileLists.js";
import {
  createProfileStore,
  DEFAULT_PROFILE_ID,
  type Profile,
  type ProfileStore,
} from "./profiles.js";

/**
 * Wire up the LLM panel. Manages a list of conversations (each with its own
 * message history, model choice, and profile) and a list of profiles (each a
 * reusable bundle of system prompt, allowed tools, and hooks — see
 * profiles.ts), both persisted across page reloads. The user can start new
 * conversations (New), switch back to old ones via the conversation
 * dropdown, assign a conversation's profile via the profile dropdown, and
 * create/edit/delete profiles in the Profiles modal (opened via the
 * "Profiles" button, its own single scroll region — never nested inside the
 * panel's own scroll). The Send button (and Ctrl/Cmd+Enter) runs a chat
 * completion for the active conversation.
 */
export function setupLlm(root: HTMLElement): void {
  const conversation =
    root.querySelector<HTMLSelectElement>("#llm-conversation");
  const model = root.querySelector<HTMLSelectElement>("#llm-model");
  const profileSelect = root.querySelector<HTMLSelectElement>("#llm-profile");
  const prompt = root.querySelector<HTMLTextAreaElement>("#llm-prompt");
  const response = root.querySelector<HTMLElement>("#llm-response");
  const send = root.querySelector<HTMLButtonElement>("#llm-send");
  const newBtn = root.querySelector<HTMLButtonElement>("#llm-new");
  const deleteBtn = root.querySelector<HTMLButtonElement>("#llm-delete");
  const context = root.querySelector<HTMLElement>("#llm-context");
  const profilesOverlay = root.querySelector<HTMLElement>(
    "#llm-profiles-overlay"
  );
  const profilesOpenBtn =
    root.querySelector<HTMLButtonElement>("#llm-profiles-open");
  const profilesCloseBtn = root.querySelector<HTMLButtonElement>(
    "#llm-profiles-close"
  );
  const profileEditor = root.querySelector<HTMLSelectElement>(
    "#llm-profile-editor"
  );
  const profileNewBtn =
    root.querySelector<HTMLButtonElement>("#llm-profile-new");
  const profileDeleteBtn = root.querySelector<HTMLButtonElement>(
    "#llm-profile-delete"
  );
  const profileName = root.querySelector<HTMLInputElement>("#llm-profile-name");
  const profilePrompt = root.querySelector<HTMLTextAreaElement>(
    "#llm-profile-prompt"
  );
  const profileTools = root.querySelector<HTMLElement>("#llm-profile-tools");
  const profileSubagentProfiles = root.querySelector<HTMLElement>(
    "#llm-profile-subagent-profiles"
  );
  const profileHook = root.querySelector<HTMLInputElement>("#llm-profile-hook");
  const profileTurnHook = root.querySelector<HTMLInputElement>(
    "#llm-profile-turn-hook"
  );
  const profileEndHook = root.querySelector<HTMLInputElement>(
    "#llm-profile-end-hook"
  );
  if (
    !conversation ||
    !model ||
    !profileSelect ||
    !prompt ||
    !response ||
    !send ||
    !context ||
    !profilesOverlay ||
    !profilesOpenBtn ||
    !profilesCloseBtn ||
    !profileEditor ||
    !profileNewBtn ||
    !profileDeleteBtn ||
    !profileName ||
    !profilePrompt ||
    !profileTools ||
    !profileSubagentProfiles ||
    !profileHook ||
    !profileTurnHook ||
    !profileEndHook
  ) {
    return;
  }

  const store = createConversationStore();
  const profiles = createProfileStore();
  const view = new MessageView(response);
  window.addEventListener("resize", () => view.refresh());

  const renderContext = () => renderContextText(context, model, store);

  const renderConversationList = () => {
    conversation.innerHTML = store
      .getConversations()
      .map((c) => `<option value="${c.id}">${escapeHtml(c.title)}</option>`)
      .join("");
    conversation.value = store.activeId();
  };

  /**
   * Rebuild both profile <select>s (the conversation's assignment picker and
   * the Profiles panel's editing target) from the current profile list,
   * preserving each one's own current selection across the rebuild (setting
   * innerHTML clears a <select>'s value).
   */
  const refreshProfileSelects = () => {
    const editingId = profileEditor.value || profiles.getDefault().id;
    const options = profiles
      .getProfiles()
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
      .join("");
    profileSelect.innerHTML = options;
    profileEditor.innerHTML = options;
    profileSelect.value = store.getActive().profileId;
    profileEditor.value = editingId;
  };

  const renderActiveMessages = () => {
    const conv = store.getActive();
    view.clearNotice();
    view.endStreaming();
    view.setMessages(conv.messages);
    if (conv.messages.length === 0) {
      view.setNotice("hint", "Start a conversation.");
    }
  };

  const showActive = () => {
    renderConversationList();
    const conv = store.getActive();
    model.value = conv.model;
    refreshProfileSelects();
    renderActiveMessages();
    renderContext();
  };

  /** Load the profile currently selected in the editor into its fields. */
  const loadProfileEditorFields = () => {
    const id = profileEditor.value || profiles.getDefault().id;
    const profile = profiles.getProfile(id) ?? profiles.getDefault();
    const isDefault = profile.id === DEFAULT_PROFILE_ID;
    profileName.value = profile.name;
    profileName.disabled = isDefault;
    profilePrompt.value = profile.systemPrompt;
    profileHook.value = profile.hookCommand;
    profileTurnHook.value = profile.turnCommand;
    profileEndHook.value = profile.endCommand;
    profileDeleteBtn.disabled = isDefault;
    renderProfileToolList(profileTools, profile, (allowed) => {
      profiles.updateProfile(profile.id, { allowedTools: allowed });
      profiles.persist();
    });
    renderSubagentProfileList(
      profileSubagentProfiles,
      profiles,
      profile,
      (allowed) => {
        profiles.updateProfile(profile.id, {
          allowedSubagentProfiles: allowed,
        });
        profiles.persist();
      }
    );
  };

  const showProfileEditor = () => {
    refreshProfileSelects();
    loadProfileEditorFields();
  };

  /** Open the Profiles modal, loading the editor fields fresh each time. */
  const openProfiles = () => {
    showProfileEditor();
    profilesOverlay.hidden = false;
    profileName.focus();
  };

  const closeProfiles = () => {
    profilesOverlay.hidden = true;
  };

  showActive();

  loadModelList(model, view, store);

  /**
   * The in-flight turn's AbortController, if any. `send` doubles as the Stop
   * button while a turn is running (see submitTurn): held here so the click
   * handler can reach the controller that started with the turn currently
   * showing "Stop".
   */
  let activeTurn: AbortController | null = null;

  const submit = () => {
    const text = prompt.value.trim();
    const m = model.value;
    if (!text || !m) return;
    prompt.value = "";
    const controller = new AbortController();
    activeTurn = controller;
    void submitTurn(
      store,
      profiles,
      view,
      send,
      m,
      text,
      showActive,
      controller.signal
    ).finally(() => {
      if (activeTurn === controller) activeTurn = null;
    });
  };

  const doNew = () => {
    resolvePendingAsk();
    activeTurn?.abort();
    // The previous conversation stays in the list so it can be reopened.
    store.newConversation(model.value);
    showActive();
    store.persist();
    prompt.focus();
  };

  const doDelete = () => {
    resolvePendingAsk();
    activeTurn?.abort();
    store.deleteConversation(store.activeId());
    showActive();
    store.persist();
    prompt.focus();
  };

  const switchConversation = (id: string) => {
    resolvePendingAsk();
    activeTurn?.abort();
    store.switchTo(id);
    showActive();
    store.persist();
  };

  const doNewProfile = () => {
    const p = profiles.createProfile("New profile");
    profiles.persist();
    // Setting a <select>'s value to an id with no matching <option> yet
    // silently no-ops, so the new profile's option must exist before it can
    // be selected — refresh first, then select it, then load its fields.
    refreshProfileSelects();
    profileEditor.value = p.id;
    loadProfileEditorFields();
    profileName.focus();
  };

  const doDeleteProfile = () => {
    const id = profileEditor.value;
    if (!profiles.deleteProfile(id)) return;
    store.reassignProfile(id, DEFAULT_PROFILE_ID);
    profiles.persist();
    store.persist();
    profileEditor.value = DEFAULT_PROFILE_ID;
    showProfileEditor();
    showActive();
  };

  send.addEventListener("click", () => {
    if (send.dataset.mode === "stop") {
      // A pending ask_questions card parks the turn on its own promise, not
      // inside the fetch the AbortController can reach — wake it the same
      // way doNew/doDelete/switchConversation do, or the abort is a silent
      // no-op until the user answers the card themselves.
      resolvePendingAsk();
      activeTurn?.abort();
      return;
    }
    submit();
  });
  newBtn?.addEventListener("click", doNew);
  deleteBtn?.addEventListener("click", doDelete);
  conversation.addEventListener("change", () =>
    switchConversation(conversation.value)
  );
  model.addEventListener("change", () => {
    store.setActiveModel(model.value);
    store.persist();
  });
  profileSelect.addEventListener("change", () => {
    store.setActiveProfile(profileSelect.value);
    store.persist();
  });
  profilesOpenBtn.addEventListener("click", openProfiles);
  profilesCloseBtn.addEventListener("click", closeProfiles);
  profilesOverlay.addEventListener("click", (e) => {
    if (e.target === profilesOverlay) closeProfiles();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !profilesOverlay.hidden) closeProfiles();
  });
  profileEditor.addEventListener("change", loadProfileEditorFields);
  profileNewBtn.addEventListener("click", doNewProfile);
  profileDeleteBtn.addEventListener("click", doDeleteProfile);
  profileName.addEventListener("change", () => {
    profiles.updateProfile(profileEditor.value, { name: profileName.value });
    profiles.persist();
    refreshProfileSelects();
  });
  profilePrompt.addEventListener("change", () => {
    profiles.updateProfile(profileEditor.value, {
      systemPrompt: profilePrompt.value,
    });
    profiles.persist();
  });
  profileHook.addEventListener("change", () => {
    profiles.updateProfile(profileEditor.value, {
      hookCommand: profileHook.value,
    });
    profiles.persist();
  });
  profileTurnHook.addEventListener("change", () => {
    profiles.updateProfile(profileEditor.value, {
      turnCommand: profileTurnHook.value,
    });
    profiles.persist();
  });
  profileEndHook.addEventListener("change", () => {
    profiles.updateProfile(profileEditor.value, {
      endCommand: profileEndHook.value,
    });
    profiles.persist();
  });
  prompt.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
  });
}

/**
 * Render the active conversation's context usage (tokens over the model's
 * window) into the context element; blank when there is nothing to show.
 */
function renderContextText(
  context: HTMLElement,
  model: HTMLSelectElement,
  store: ReturnType<typeof createConversationStore>
): void {
  const conv = store.getActive();
  const cap = store.getContextWindow(model.value);
  const tokens = store.getPromptTokens(conv.id);
  if (tokens === undefined || !cap) {
    context.textContent = "";
    return;
  }
  const pct = (tokens / cap) * 100;
  context.textContent = `Context: ${tokens.toLocaleString()} / ${cap.toLocaleString()} tokens (${pct.toFixed(1)}%)`;
  context.title =
    "Tokens sent to the model in the latest call, over the model's " +
    "context window.";
}

/**
 * Load the model list from the proxy and populate the dropdown, recording each
 * model's context window for the usage meter. Restores the active
 * conversation's saved choice when the proxy still serves it.
 */
function loadModelList(
  model: HTMLSelectElement,
  view: MessageView,
  store: ReturnType<typeof createConversationStore>
): void {
  listLlmModels()
    .then((models) => {
      if (models.length === 0) {
        view.setNotice("hint", "No models served.");
        return;
      }
      model.innerHTML = models
        .map((m) => `<option value="${m.id}">${m.id}</option>`)
        .join("");
      for (const m of models) {
        if (m.context) store.setContextWindow(m.id, m.context);
      }
      const conv = store.getActive();
      if (conv.model && models.some((m) => m.id === conv.model)) {
        model.value = conv.model;
      }
    })
    .catch((e: unknown) =>
      view.setNotice(
        "error",
        `Failed to load models: ${e instanceof Error ? e.message : e}`
      )
    );
}

/** Escape a string for safe interpolation into an <option>'s label. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Run a full turn: push the user message, then loop on the model. Each time the
 * model requests tool calls, execute them against the file tree and feed the
 * results back; stop when it returns a plain text reply, which is returned to
 * the caller for rendering and persistence. On failure the history is rolled
 * back so the conversation stays consistent.
 */
const MAX_TOOL_TURNS = 5;

/** Everything systemPrompt()/buildMessages() need to build one turn's outgoing prompt. */
interface PromptContext {
  /** The active profile's own system prompt text. */
  base: string;
  /** Tool names not allowed under the active profile. */
  disabled: string[];
  /** The startup hook's cached output, if any. */
  hookOutput?: string;
  /** This turn's fresh turn-hook output, if any. */
  turnOutput?: string;
  /** Other profile names to mention for create_subagent delegation (omitted for a subagent's own loop, which cannot nest). */
  profileNames?: string[];
}

/**
 * The system prompt for one turn: the active profile's own base text, with a
 * note appended for any tools the profile doesn't allow, the startup hook's
 * (cached) output, this turn's fresh hook output, and the names of other
 * profiles available for create_subagent delegation — each only when
 * present, so a profile with none of these produces a prompt byte-identical
 * to its own base text (the request's prefix, and thus the KV cache, is
 * unchanged for an unaffected profile).
 */
function systemPrompt(ctx: PromptContext): string {
  let text = ctx.base;
  if (ctx.disabled.length > 0) {
    text +=
      ` The following tools are not available in the current profile and ` +
      `must not be called: ${ctx.disabled.join(", ")}. If a task needs one ` +
      "of them, tell the user it isn't available and ask them to add it to " +
      "the profile's allowed tools.";
  }
  if (ctx.hookOutput) {
    text +=
      "\n\nBefore this conversation began, the following startup command " +
      `was run in the workspace and produced this output:\n${ctx.hookOutput}`;
  }
  if (ctx.turnOutput) {
    text +=
      "\n\nJust before this turn, the following turn command was run in " +
      `the workspace and produced this output:\n${ctx.turnOutput}`;
  }
  if (ctx.profileNames && ctx.profileNames.length > 0) {
    text +=
      "\n\nWhen delegating with create_subagent, pass `profile` set to one " +
      "of these profile names; the helper runs under that profile's own " +
      `system prompt, tools, and hooks: ${ctx.profileNames.join(", ")}.`;
  }
  return text;
}

/**
 * Run a hook command through the same run_command tool the model uses, and
 * return its output (including error text — the backend resolves failures to
 * an "Error: …" string rather than throwing).
 */
async function runHookCommand(command: string): Promise<string> {
  return executeLlmTool({
    id: "hook",
    type: "function",
    function: { name: "run_command", arguments: JSON.stringify({ command }) },
  });
}

/** Max characters of an end-hook command's combined stdout+stderr shown/sent. */
const END_HOOK_OUTPUT_CHARS = 500;

/**
 * Combine and truncate an end-of-turn hook command's stdout/stderr for
 * display (and, when it blocks a turn, for the message sent back to the
 * model — the two share one truncation policy rather than maintaining two).
 */
function formatEndHookOutput(
  command: string,
  result: ShellCommandResult
): string {
  const combined = result.stderr
    ? `${result.stdout}\n[stderr]\n${result.stderr}`
    : result.stdout;
  const body =
    combined.length > END_HOOK_OUTPUT_CHARS
      ? `${combined.slice(0, END_HOOK_OUTPUT_CHARS)}\n… (truncated)`
      : combined;
  const status = result.timedOut
    ? "timed out"
    : result.stderr
      ? "stderr present"
      : "ok";
  return `End-of-turn check: $ ${command}\n${status}\n${body}`.trimEnd();
}

/**
 * The message fed back to the model when the end-of-turn hook blocks a turn
 * (its command wrote to stderr): the model sees why and gets another attempt.
 */
function endHookRetryMessage(
  command: string,
  result: ShellCommandResult
): string {
  return (
    "The end-of-turn check command wrote to stderr, so this reply was not " +
    "accepted. Review the output below, fix the issue, and reply again.\n\n" +
    formatEndHookOutput(command, result)
  );
}

/** The outcome of an end-hook check on a candidate reply. */
interface EndHookOutcome {
  /**
   * True when the reply is rejected — stderr present, or the check itself
   * failed to run — and the caller should retry instead of accepting the
   * candidate text.
   */
  blocked: boolean;
  /** The check's (possibly truncated) display text, for the transcript. */
  summary: string;
  /** Present only when blocked: the message to feed back to the model as a retry turn. */
  retryMessage?: string;
}

/**
 * Run a profile's end-of-turn check command against a candidate reply.
 * Shared by runTurn (the main conversation loop) and runSubagent (a
 * delegated helper's loop) so both gate a reply on stderr identically,
 * including treating the check's own execution failure (a spawn error, or a
 * single-flight collision with another in-flight command) as blocking rather
 * than silently accepting the reply or throwing into the caller's own
 * failure handling (which, for runTurn, would otherwise roll back the whole
 * turn's persisted history — see the architecture doc).
 */
async function checkEndHook(command: string): Promise<EndHookOutcome> {
  let check: ShellCommandResult;
  try {
    check = await runShellCommand(command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      blocked: true,
      summary: `End-of-turn check: $ ${command}\ncould not run: ${message}`,
      retryMessage: `The end-of-turn check command could not be run (${message}). Reply again.`,
    };
  }
  const summary = formatEndHookOutput(command, check);
  if (check.stderr) {
    return {
      blocked: true,
      summary,
      retryMessage: endHookRetryMessage(command, check),
    };
  }
  return { blocked: false, summary };
}

/** Model-readable result returned when the active profile doesn't allow a tool. */
function disabledToolResult(name: string, profileName: string): string {
  return (
    `${name} is not available in the "${profileName}" profile. Do not call ` +
    "it; if you need its capability, tell the user to add it to the " +
    "profile's allowed tools."
  );
}

/** Every known tool name that `allowed` does not include. */
function disabledFromAllowed(allowed: string[]): string[] {
  return llmToolDefinitions
    .map((t) => t.function.name)
    .filter((name) => !allowed.includes(name));
}

/** Maximum tool-call rounds a subagent may run before it must give a final answer. */
const SUBAGENT_MAX_TOOL_TURNS = 5;

/**
 * The tool definitions offered to a subagent: llmToolDefinitions filtered to
 * the given profile's allowedTools, always excluding the two client-executed
 * tools that a headless subagent cannot fulfil — create_subagent (so a
 * subagent can never spawn further subagents) and ask_questions (its
 * collapsed transcript has no room for an interactive card, and its loop has
 * no way to pause for a user). Both are excluded regardless of what a
 * profile's own allowedTools happens to list.
 */
function subagentToolDefs(profile: Profile): LlmTool[] {
  return llmToolDefinitions.filter(
    (t) =>
      t.function.name !== "create_subagent" &&
      t.function.name !== "ask_questions" &&
      profile.allowedTools.includes(t.function.name)
  );
}

/**
 * The profiles a subagent spawned under `profile` may run under: every
 * profile when `allowedSubagentProfiles` is empty (unrestricted), otherwise
 * only the ids in that list. A profile's own id is always included — a
 * subagent is always allowed to run under its parent's profile.
 */
function availableSubagentProfiles(
  profile: Profile,
  profiles: ProfileStore
): Profile[] {
  return profiles
    .getProfiles()
    .filter(
      (p) =>
        p.id === profile.id ||
        profile.allowedSubagentProfiles.length === 0 ||
        profile.allowedSubagentProfiles.includes(p.id)
    );
}

/** Parse the `task`/`profile` arguments out of a create_subagent tool call. */
function parseSubagentArgs(tc: LlmToolCall): {
  task: string;
  profile: string;
} {
  try {
    const args = JSON.parse(tc.function.arguments) as {
      task?: unknown;
      profile?: unknown;
    };
    return {
      task: typeof args.task === "string" ? args.task : "",
      profile: typeof args.profile === "string" ? args.profile : "",
    };
  } catch {
    return { task: "", profile: "" };
  }
}

/** Parse the `questions` argument out of an ask_questions tool call. */
function parseAskQuestionsArgs(tc: LlmToolCall): AskQuestion[] {
  try {
    const args = JSON.parse(tc.function.arguments) as {
      questions?: unknown;
    };
    if (!Array.isArray(args.questions)) return [];
    const out: AskQuestion[] = [];
    for (const q of args.questions) {
      if (typeof q !== "object" || q === null) continue;
      const o = q as Record<string, unknown>;
      if (typeof o.question !== "string") continue;
      const item: AskQuestion = { question: o.question };
      if (Array.isArray(o.options)) {
        item.options = (o.options as unknown[]).filter(
          (v): v is string => typeof v === "string"
        );
      }
      if (typeof o.multi_select === "boolean") {
        item.multiSelect = o.multi_select;
      }
      out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

/** The outcome of resolving one model tool call. */
interface ToolCallOutcome {
  result: string;
  /** Present only for a create_subagent call: its internal trace, for the collapsed transcript block. */
  steps?: SubagentStep[];
  /** Present only for a create_subagent call: the task it was given. */
  task?: string;
}

/**
 * Resolve a single tool call to its model-readable result. Tools the active
 * profile doesn't allow are short-circuited client-side; create_subagent
 * runs its own nested loop under the named profile its `profile` argument
 * refers to (a missing or unrecognized profile is a model-readable error);
 * everything else is forwarded to the backend.
 */
async function resolveToolCall(
  tc: LlmToolCall,
  model: string,
  profile: Profile,
  profiles: ProfileStore,
  view: MessageView
): Promise<ToolCallOutcome> {
  const name = tc.function.name;
  const disabled = disabledFromAllowed(profile.allowedTools);
  if (disabled.includes(name)) {
    return { result: disabledToolResult(name, profile.name) };
  }
  if (name === "ask_questions") {
    const questions = parseAskQuestionsArgs(tc);
    if (questions.length === 0) {
      return {
        result:
          "ask_questions requires a `questions` argument: an array of one or " +
          "more {question, options?, multi_select?} objects.",
      };
    }
    const result = await askQuestions(view, questions);
    return { result };
  }
  if (name === "create_subagent") {
    const { task, profile: profileName } = parseSubagentArgs(tc);
    const available = availableSubagentProfiles(profile, profiles);
    const availableNames = available.map((p) => p.name);
    if (!profileName) {
      return {
        result:
          "create_subagent requires a `profile` argument: the name of a " +
          "profile to run the helper under. Available profiles: " +
          availableNames.join(", ") +
          ".",
      };
    }
    const target = available.find((p) => p.name === profileName);
    if (!target) {
      return {
        result:
          `No profile named "${profileName}". Available profiles: ` +
          availableNames.join(", ") +
          ".",
      };
    }
    const { result, steps } = await runSubagent(task, model, target);
    return { result, steps, task };
  }
  return { result: await executeLlmTool(tc) };
}

/**
 * Run an independent, bounded tool-calling loop for a single delegated task,
 * under the named profile the model chose. The subagent gets its own message
 * history (just the task, not the parent conversation). Nothing here is
 * persisted to the conversation store; only the final result and the step
 * trace (for the collapsed transcript block) are returned to the caller.
 * Mirrors runTurn's hook orchestration: the profile's startup hook runs once
 * before the loop, its turn hook runs fresh before every iteration, and its
 * end hook gates each candidate final answer on stderr, looping (within the
 * same bounded budget) instead of accepting a rejected reply.
 */
async function runSubagent(
  task: string,
  model: string,
  profile: Profile
): Promise<{ result: string; steps: SubagentStep[] }> {
  const tools = subagentToolDefs(profile);
  const disabled = disabledFromAllowed(profile.allowedTools);
  const steps: SubagentStep[] = [];
  const messages: LlmMessage[] = [
    { role: "system", content: profile.systemPrompt },
    { role: "user", content: task },
  ];
  const hookOutput = profile.hookCommand
    ? await runHookCommand(profile.hookCommand)
    : undefined;
  for (let i = 0; i < SUBAGENT_MAX_TOOL_TURNS; i++) {
    const turnOutput = profile.turnCommand
      ? await runHookCommand(profile.turnCommand)
      : undefined;
    messages[0] = {
      role: "system",
      content: systemPrompt({
        base: profile.systemPrompt,
        disabled,
        hookOutput,
        turnOutput,
      }),
    };
    const reply = await sendLlmMessage(messages, model, tools);
    if (reply.tool_calls && reply.tool_calls.length > 0) {
      messages.push({
        role: "assistant",
        content: reply.content,
        tool_calls: reply.tool_calls,
      });
      for (const tc of reply.tool_calls) {
        steps.push({ kind: "tool-call", text: toolCallLabel(tc) });
      }
      for (const tc of reply.tool_calls) {
        const name = tc.function.name;
        const result = disabled.includes(name)
          ? disabledToolResult(name, profile.name)
          : await executeLlmTool(tc);
        messages.push({ role: "tool", content: result, tool_call_id: tc.id });
        steps.push({ kind: "tool-result", text: result });
      }
      continue;
    }
    const text = reply.content ?? "";
    if (profile.endCommand) {
      const outcome = await checkEndHook(profile.endCommand);
      steps.push({ kind: "end-hook", text: outcome.summary });
      if (outcome.blocked) {
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: outcome.retryMessage ?? "" });
        continue;
      }
    }
    return { result: text, steps };
  }
  return {
    result:
      "The subagent stopped after several tool calls without a final answer.",
    steps,
  };
}

/** The outcome of a turn: the assistant text and its final token usage. */
export interface TurnResult {
  text: string;
  /** The model's chain-of-thought for the final reply, if it produced any. */
  reasoning?: string;
  usage?: LlmUsage;
}

/**
 * Module-level state for the pending ask_questions card. At most one
 * ask_questions is in flight at a time (the turn loop is single-threaded per
 * conversation, and the user can only answer the active conversation's
 * question). `pendingAsk` holds the questions, the card handle, and a unique
 * id so `onAnswer` can ignore stale callbacks if a newer question replaced
 * the card before the user answered.
 */
let pendingAsk:
  | {
      id: number;
      questions: AskQuestion[];
      handle: AskCardHandle;
      resolve: (result: string) => void;
    }
  | undefined;
let pendingAskSeq = 0;

/**
 * Clear the pending ask_questions, if any: mark the card as not answered,
 * remove it from the DOM, and resolve its promise with the "not answered"
 * result. Called when the user starts a new turn, starts a new conversation,
 * or deletes one — in all three cases the pending question is abandoned and
 * the model gets a "not answered" tool result so it can adapt.
 */
function resolvePendingAsk(): void {
  if (!pendingAsk) return;
  const result = pendingAsk.handle.resolveNotAnswered(pendingAsk.questions);
  pendingAsk.resolve(result);
  pendingAsk = undefined;
}

/**
 * Ask the user questions and wait for their answers. Renders an interactive
 * card in the transcript (ephemeral — not part of the persisted conversation
 * history), pauses the turn, and resolves with the model-readable result
 * string ("Q1: answer1\nQ2: answer2"). If the pending question is abandoned
 * (new turn, new conversation, etc.), it resolves with a "not answered"
 * result so the model can adapt.
 */
async function askQuestions(
  view: MessageView,
  questions: AskQuestion[]
): Promise<string> {
  const id = ++pendingAskSeq;
  return new Promise<string>((resolve) => {
    const handle = renderAskQuestionsCard(
      view.scrollElement,
      questions,
      (result) => {
        // Guard against a stale callback: if a newer question replaced the
        // card before the user answered this one, ignore the old callback.
        if (pendingAsk?.id !== id) return;
        pendingAsk = undefined;
        view.notifyExternalContent();
        resolve(result);
      }
    );
    view.notifyExternalContent();
    pendingAsk = { id, questions, handle, resolve };
  });
}

/**
 * Run one submit end to end: the active profile's startup hook (first
 * message only, cached), then its per-turn hook (every turn, run fresh and
 * never cached), then the model turn — updating the view/store/send-button
 * state throughout. Extracted out of `setupLlm` so that closure stays a thin
 * wiring function.
 */
async function submitTurn(
  store: ConversationStore,
  profiles: ProfileStore,
  view: MessageView,
  send: HTMLButtonElement,
  model: string,
  text: string,
  showActive: () => void,
  signal: AbortSignal
): Promise<void> {
  const conv = store.getActive();
  const profile = profiles.getProfile(conv.profileId) ?? profiles.getDefault();
  const hookCommand = profile.hookCommand.trim();
  const needsHook =
    conv.messages.length === 0 &&
    hookCommand !== "" &&
    conv.hookOutput === undefined;
  const turnCommand = profile.turnCommand.trim();
  send.dataset.mode = "stop";
  send.textContent = "Stop";
  send.title = "Stop the model's reply";
  resolvePendingAsk();
  try {
    if (needsHook) {
      view.setNotice("loading", "Running startup command…");
      store.setHookOutput(await runHookCommand(hookCommand));
      store.persist();
    }
    let turnOutput: string | undefined;
    if (turnCommand !== "") {
      view.setNotice("loading", "Running turn command…");
      turnOutput = await runHookCommand(turnCommand);
    }
    view.setNotice("loading", "Thinking…");
    const result = await runTurn(
      store,
      profiles,
      profile,
      model,
      view,
      text,
      store.getContextWindow(model),
      store.getPromptTokens(conv.id),
      signal,
      turnOutput
    );
    view.clearNotice();
    view.appendMessage({
      role: "assistant",
      content: result.text,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    });
    store.commitTurn(result.usage);
    showActive();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      // The user switched conversations mid-turn; the view already shows
      // the new conversation, so no error notice is needed.
    } else {
      view.setNotice(
        "error",
        `Request failed: ${e instanceof Error ? e.message : e}`
      );
    }
  } finally {
    send.dataset.mode = "send";
    send.textContent = "Send";
    send.title = "";
  }
}

async function runTurn(
  store: ConversationStore,
  profiles: ProfileStore,
  profile: Profile,
  model: string,
  view: MessageView,
  userText: string,
  cap: number | undefined,
  lastPromptTokens: number | undefined,
  signal: AbortSignal,
  turnOutput?: string
): Promise<TurnResult> {
  const turnConvId = store.activeId();
  const history = store.getActive().messages;
  const preLength = history.length;
  const disabled = disabledFromAllowed(profile.allowedTools);
  const hookOutput = store.getActive().hookOutput;
  const endCommand = profile.endCommand.trim();
  const profileNames = disabled.includes("create_subagent")
    ? undefined
    : availableSubagentProfiles(profile, profiles).map((p) => p.name);
  let lastUsage: LlmUsage | undefined;
  const abortIfSwitched = (): void => {
    if (store.activeId() !== turnConvId) {
      history.length = preLength;
      throw new DOMException(
        "Turn aborted: conversation switched",
        "AbortError"
      );
    }
  };
  try {
    // If the previous call already used 80% of the window, summarize the
    // conversation and append a compaction marker before this turn's calls, so
    // the outgoing prompt drops the pre-summary history (append-only: nothing
    // is ever removed from `history`).
    if (
      cap !== undefined &&
      cap > 0 &&
      lastPromptTokens !== undefined &&
      lastPromptTokens / cap >= COMPACT_THRESHOLD
    ) {
      const summary = await summarizeConversation(history, model);
      abortIfSwitched();
      if (summary) {
        history.push({
          role: "user",
          content: summary,
          compaction: true,
        });
        view.appendCompaction();
      }
    }
    history.push({ role: "user", content: userText });
    view.appendMessage({ role: "user", content: userText });
    for (let i = 0; i < MAX_TOOL_TURNS; i++) {
      const messages = buildMessages(history, {
        base: profile.systemPrompt,
        disabled,
        hookOutput,
        turnOutput,
        profileNames,
      });
      let streamingStarted = false;
      const ensureStreamingStarted = (): void => {
        if (!streamingStarted) {
          view.beginStreaming();
          view.clearNotice();
          streamingStarted = true;
        }
      };
      const reply = await streamLlmMessage(
        messages,
        model,
        llmToolDefinitions,
        (text) => {
          ensureStreamingStarted();
          view.updateStreaming(text);
        },
        (reasoning) => {
          ensureStreamingStarted();
          view.updateReasoning(reasoning);
        },
        signal
      );
      lastUsage = reply.usage ?? lastUsage;
      abortIfSwitched();
      if (signal.aborted) {
        // The user clicked Stop: finalize now with whatever text (if any)
        // was generated before the abort, skipping any tool calls the reply
        // may have (possibly incomplete, mid-stream) and the end-of-turn
        // hook check, which would otherwise fight the user's stop.
        view.endStreaming();
        const text =
          reply.content && reply.content.trim() !== ""
            ? reply.content
            : "(Stopped before the model replied.)";
        history.push({
          role: "assistant",
          content: text,
          ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
        });
        return {
          text,
          reasoning: reply.reasoning ?? undefined,
          usage: lastUsage,
        };
      }
      if (reply.tool_calls && reply.tool_calls.length > 0) {
        // The reply is tool calls, not text: drop the ephemeral streaming
        // block (it may hold partial text the model generated alongside the
        // calls) so only the tool-call labels are shown, matching the
        // non-streaming behavior where tool-call content is not rendered as
        // a separate message block.
        view.endStreaming();
        history.push({
          role: "assistant",
          content: reply.content,
          tool_calls: reply.tool_calls,
        });
        for (const tc of reply.tool_calls) {
          view.appendToolCall(toolCallLabel(tc));
        }
        for (const tc of reply.tool_calls) {
          const outcome = await resolveToolCall(
            tc,
            model,
            profile,
            profiles,
            view
          );
          abortIfSwitched();
          history.push({
            role: "tool",
            content: outcome.result,
            tool_call_id: tc.id,
          });
          if (outcome.steps) {
            view.appendSubagentResult(
              outcome.task ?? "",
              outcome.steps,
              outcome.result
            );
          } else {
            view.appendToolResult(outcome.result);
          }
        }
        continue;
      }
      const text = reply.content ?? "";
      view.endStreaming();
      history.push({
        role: "assistant",
        content: text,
        ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
      });
      if (endCommand) {
        const outcome = await checkEndHook(endCommand);
        abortIfSwitched();
        if (outcome.blocked) {
          // This reply is rejected: show it and the check's output now (it
          // will never be rendered as the turn's final answer), record a
          // protocol-valid retry turn so the model sees why, and loop.
          view.appendMessage({ role: "assistant", content: text });
          view.appendEndHookResult(outcome.summary);
          history.push({
            role: "user",
            content: outcome.retryMessage ?? "",
            endHook: true,
          });
          continue;
        }
        view.appendEndHookResult(outcome.summary);
      }
      return {
        text,
        reasoning: reply.reasoning ?? undefined,
        usage: lastUsage,
      };
    }
    const text =
      "I stopped after several directory lookups without a final answer.";
    history.push({ role: "assistant", content: text });
    return { text, usage: lastUsage };
  } catch (err) {
    history.length = preLength;
    view.endStreaming();
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    view.setMessages(store.getActive().messages);
    throw err;
  }
}

/** Fraction of the context window (of the latest call) that triggers a compaction. */
const COMPACT_THRESHOLD = 0.8;

const SUMMARY_PROMPT =
  "Summarize the entire conversation above into a concise brief that " +
  "preserves the key facts, decisions, and any in-progress task, so the " +
  "conversation can continue from your summary alone. Reply with only the " +
  "summary text, with no preamble.";

/**
 * Convert a stored message to its wire form, dropping the display-only
 * `reasoning` field: the model's own chain-of-thought is shown to the user
 * but must not be echoed back to the model on the next turn.
 */
function toWireMessage(m: ChatMessage): LlmMessage {
  const { reasoning: _reasoning, ...wire } = m;
  return wire;
}

/**
 * Build the outgoing prompt: the system prompt, then the latest compaction
 * summary (if any) in place of the pre-summary history, then the turns after
 * it. Without a compaction the full history is sent.
 */
function buildMessages(
  history: ChatMessage[],
  ctx: PromptContext
): LlmMessage[] {
  let cut = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].compaction) {
      cut = i;
      break;
    }
  }
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt(ctx) },
  ];
  if (cut >= 0) {
    messages.push({ role: "user", content: history[cut].content ?? "" });
    for (let i = cut + 1; i < history.length; i++) {
      messages.push(toWireMessage(history[i]));
    }
  } else {
    for (const m of history) messages.push(toWireMessage(m));
  }
  return messages;
}

/**
 * Ask the model to summarize the conversation so far; the result becomes the
 * compaction message. Returns "" if no usable summary came back.
 */
async function summarizeConversation(
  history: ChatMessage[],
  model: string
): Promise<string> {
  // Reuse the compacted conversation so the rescue call isn't itself larger
  // than the prompt that just measured >= 80% of the window; only the system
  // prompt differs (the summary brief instead of the tool instructions), and
  // that first message is dropped below anyway, so the ctx passed here is a
  // placeholder.
  const compacted = buildMessages(history, { base: "", disabled: [] });
  const messages: LlmMessage[] = [
    { role: "system", content: SUMMARY_PROMPT },
    ...compacted.slice(1),
  ];
  const reply = await sendLlmMessage(messages, model);
  return (reply.content ?? "").trim();
}
