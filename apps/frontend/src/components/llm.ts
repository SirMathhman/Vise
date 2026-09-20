import {
  executeLlmTool,
  executeLlmToolWithImages,
  getFile,
  type LlmContentPart,
  type LlmMessage,
  type LlmToolCall,
  type LlmUsage,
  listLlmModels,
  runShellCommand,
  type ShellCommandResult,
  sendLlmMessage,
  streamLlmMessage,
} from "../api/client.js";
import {
  extractPartialJsonNumber,
  extractPartialJsonString,
} from "../llm/partialJson.js";
import {
  disabledFromAllowed,
  disabledToolResult,
  offeredToolsFor,
  parseAskQuestionsArgs,
  parseSubagentArgs,
  parseUseSkillArgs,
  searchToolsResult,
  subagentToolDefs,
  unwrapCallTool,
} from "../llm/toolCalls.js";
import { DEFERRED_TOOL_NAMES } from "../llm/tools.js";
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
import type { FileViewerHandle } from "./fileTree.js";
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
import { createSkillStore, type SkillStore } from "./skills.js";

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
export function setupLlm(
  root: HTMLElement,
  fileViewer: FileViewerHandle | undefined
): void {
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
  const profileMaxToolTurns = root.querySelector<HTMLInputElement>(
    "#llm-profile-max-tool-turns"
  );
  const skillsOverlay = root.querySelector<HTMLElement>("#llm-skills-overlay");
  const skillsOpenBtn =
    root.querySelector<HTMLButtonElement>("#llm-skills-open");
  const skillsCloseBtn =
    root.querySelector<HTMLButtonElement>("#llm-skills-close");
  const skillEditor =
    root.querySelector<HTMLSelectElement>("#llm-skill-editor");
  const skillNewBtn = root.querySelector<HTMLButtonElement>("#llm-skill-new");
  const skillDeleteBtn =
    root.querySelector<HTMLButtonElement>("#llm-skill-delete");
  const skillName = root.querySelector<HTMLInputElement>("#llm-skill-name");
  const skillSummary =
    root.querySelector<HTMLInputElement>("#llm-skill-summary");
  const skillContent =
    root.querySelector<HTMLTextAreaElement>("#llm-skill-content");
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
    !profileEndHook ||
    !profileMaxToolTurns ||
    !skillsOverlay ||
    !skillsOpenBtn ||
    !skillsCloseBtn ||
    !skillEditor ||
    !skillNewBtn ||
    !skillDeleteBtn ||
    !skillName ||
    !skillSummary ||
    !skillContent
  ) {
    return;
  }

  const store = createConversationStore();
  const profiles = createProfileStore();
  const skills = createSkillStore();
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
    autoResizeTextarea(profilePrompt);
    profileHook.value = profile.hookCommand;
    profileTurnHook.value = profile.turnCommand;
    profileEndHook.value = profile.endCommand;
    profileMaxToolTurns.value = String(profile.maxToolTurns);
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
    // Un-hide the overlay before loading fields: autoResizeTextarea in
    // loadProfileEditorFields measures the textarea's scrollHeight, which
    // is 0 while the overlay is hidden (display:none), so the resize
    // would otherwise compute only the min-height floor and the textarea
    // would still need its own scrollbar for a long prompt.
    profilesOverlay.hidden = false;
    showProfileEditor();
    profileName.focus();
  };

  const closeProfiles = () => {
    profilesOverlay.hidden = true;
  };

  /** Rebuild the skill <select> from the current skill list, preserving the current selection. */
  const refreshSkillSelect = () => {
    const editingName = skillEditor.value;
    const options = skills
      .getSkills()
      .map(
        (s) =>
          `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`
      )
      .join("");
    skillEditor.innerHTML = options;
    skillEditor.value = editingName;
    if (!skillEditor.value)
      skillEditor.disabled = skills.getSkills().length === 0;
  };

  /** Load the skill currently selected in the editor into its fields. */
  const loadSkillEditorFields = () => {
    const name = skillEditor.value;
    const skill = skills.getSkill(name);
    skillName.value = skill?.name ?? "";
    skillSummary.value = skill?.summary ?? "";
    skillContent.value = skill?.content ?? "";
    autoResizeTextarea(skillContent);
    skillDeleteBtn.disabled = !skill;
  };

  /** Open the Skills modal, loading the editor fields fresh each time. */
  const openSkills = () => {
    // Un-hide the overlay before loading fields: autoResizeTextarea in
    // loadSkillEditorFields measures the textarea's scrollHeight, which is 0
    // while the overlay is hidden (display:none), so the resize would
    // otherwise compute only the min-height floor and the textarea would
    // still need its own scrollbar for a long skill.
    skillsOverlay.hidden = false;
    refreshSkillSelect();
    loadSkillEditorFields();
    skillSummary.focus();
  };

  const closeSkills = () => {
    skillsOverlay.hidden = true;
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
      fileViewer,
      send,
      m,
      text,
      showActive,
      controller.signal,
      skills
    ).finally(() => {
      if (activeTurn === controller) activeTurn = null;
    });
  };

  const doNew = () => {
    resolvePendingAsk();
    resolvePendingApproval();
    activeTurn?.abort();
    // The previous conversation stays in the list so it can be reopened.
    store.newConversation(model.value);
    showActive();
    store.persist();
    prompt.focus();
  };

  const doDelete = () => {
    resolvePendingAsk();
    resolvePendingApproval();
    activeTurn?.abort();
    store.deleteConversation(store.activeId());
    showActive();
    store.persist();
    prompt.focus();
  };

  const switchConversation = (id: string) => {
    resolvePendingAsk();
    resolvePendingApproval();
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
      resolvePendingApproval();
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
    autoResizeTextarea(profilePrompt);
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
  profileMaxToolTurns.addEventListener("change", () => {
    const n = Math.max(1, Math.trunc(Number(profileMaxToolTurns.value) || 100));
    profiles.updateProfile(profileEditor.value, { maxToolTurns: n });
    profiles.persist();
  });

  const doNewSkill = () => {
    const name = skillName.value.trim();
    if (!name) return;
    // createSkill returns undefined when a skill with that name already
    // exists (the name is the uniqueness key and is fixed after creation);
    // a no-op in that case, so clicking New twice with the same name is safe.
    if (skills.createSkill(name) === undefined) return;
    skills.persist();
    // Select the new skill in the dropdown and load its (empty) fields; the
    // name input now reflects the new skill's fixed name.
    refreshSkillSelect();
    skillEditor.value = name;
    loadSkillEditorFields();
    skillSummary.focus();
  };

  const doDeleteSkill = () => {
    const name = skillEditor.value;
    if (!name || !skills.deleteSkill(name)) return;
    skills.persist();
    refreshSkillSelect();
    loadSkillEditorFields();
  };

  skillsOpenBtn.addEventListener("click", openSkills);
  skillsCloseBtn.addEventListener("click", closeSkills);
  skillsOverlay.addEventListener("click", (e) => {
    if (e.target === skillsOverlay) closeSkills();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !skillsOverlay.hidden) closeSkills();
  });
  skillEditor.addEventListener("change", loadSkillEditorFields);
  skillNewBtn.addEventListener("click", doNewSkill);
  skillDeleteBtn.addEventListener("click", doDeleteSkill);
  skillSummary.addEventListener("change", () => {
    const name = skillEditor.value;
    if (name) {
      skills.updateSkill(name, { summary: skillSummary.value });
      skills.persist();
    }
  });
  skillContent.addEventListener("change", () => {
    autoResizeTextarea(skillContent);
    const name = skillEditor.value;
    if (name) {
      skills.updateSkill(name, { content: skillContent.value });
      skills.persist();
    }
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
 * Auto-resize a <textarea> to fit its content (and never less than 96px),
 * so it never shows its own scrollbar. The Profiles modal is the single
 * scroll region for its form; a fixed-height textarea holding a long system
 * prompt would otherwise be a second, nested scroll region. The border is
 * added to the measured scrollHeight because scrollHeight does not include
 * border, but the content-box height does — without it the content would
 * overflow the visible area by the border width and show a scrollbar.
 */
function autoResizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  const cs = getComputedStyle(el);
  const border =
    parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  el.style.height = `${Math.max(el.scrollHeight + border, 96)}px`;
}

/**
 * Run a full turn: push the user message, then loop on the model. Each time the
 * model requests tool calls, execute them against the file tree and feed the
 * results back; stop when it returns a plain text reply, which is returned to
 * the caller for rendering and persistence. On failure the history is rolled
 * back so the conversation stays consistent.
 */
/**
 * Fallback tool-turn cap for a profile missing maxToolTurns (e.g. pre-
 * profiles persisted data). Profiles carry their own cap; this is only the
 * safety net when the field is absent. 100 — see Profile.maxToolTurns for
 * why 5 (the original hard cap) was far too few for local models doing file
 * exploration.
 */
const MAX_TOOL_TURNS = 100;

/**
 * Module-level state for the pending "allow more rounds" approval. At most
 * one approval is in flight at a time (the turn loop is single-threaded per
 * conversation). Holds the Yes/No card handle and the unique id so the
 * onAnswer callback can ignore a stale card if a newer turn replaced it
 * before the user answered. The user's answer decides whether runTurn's loop
 * keeps going past its configured cap.
 */
let pendingApproval:
  | {
      id: number;
      handle: AskCardHandle;
      resolve: (approved: boolean) => void;
    }
  | undefined;
let pendingApprovalSeq = 0;

/**
 * Clear the pending more-rounds approval, if any: remove the card from the
 * DOM and resolve its promise with false ("not approved") so the turn loop
 * exits. Called when the user starts a new turn, switches conversation, or
 * deletes one — the in-flight approval is abandoned and the turn ends.
 */
function resolvePendingApproval(): void {
  if (!pendingApproval) return;
  pendingApproval.handle.resolveNotAnswered([]);
  pendingApproval.resolve(false);
  pendingApproval = undefined;
}

/**
 * Ask the user, via a Yes/No card in the transcript, whether to allow more
 * tool rounds. Pauses the turn until they answer (or the card is abandoned,
 * which counts as "no"). Returns true only when they approved.
 */
function requestMoreRounds(view: MessageView): Promise<boolean> {
  const id = ++pendingApprovalSeq;
  return new Promise<boolean>((resolve) => {
    const handle = renderAskQuestionsCard(
      view.scrollElement,
      [
        {
          question:
            "The model used up its tool budget without a final answer. " +
            "Allow more rounds so it can keep working?",
          options: ["Yes", "No"],
        },
      ],
      (result) => {
        // Guard against a stale callback: if a newer turn replaced the card
        // before the user answered this one, ignore it.
        if (pendingApproval?.id !== id) return;
        pendingApproval = undefined;
        view.notifyExternalContent();
        // Approve only on an explicit "yes" (any casing); a "no" or free
        // text that isn't a yes counts as not approved.
        resolve(result.toLowerCase().includes("yes"));
      }
    );
    view.notifyExternalContent();
    pendingApproval = { id, handle, resolve: (b: boolean) => resolve(b) };
  });
}

/** Everything systemPrompt()/buildMessages() need to build one turn's outgoing prompt. */
interface PromptContext {
  /** The active profile's own system prompt text. */
  base: string;
  /** Tool names not allowed under the active profile. */
  disabled: string[];
  /** Allowed tools not loaded up front, found with search_tools and run with call_tool. */
  deferred?: string[];
  /** The startup hook's cached output, if any. */
  hookOutput?: string;
  /** This turn's fresh turn-hook output, if any. */
  turnOutput?: string;
  /** Other profile names to mention for create_subagent delegation (omitted for a subagent's own loop, which cannot nest). */
  profileNames?: string[];
  /** The workspace's cached AGENTS.md text, if present. */
  agentsMd?: string;
  /** The available skills' "name: summary" lines, if any. */
  skillSummaries?: string[];
}

/**
 * The workspace root's AGENTS.md path (relative), the file whose content is
 * auto-loaded into every profile's system prompt.
 */
const AGENTS_MD_PATH = "AGENTS.md";

/**
 * Load the workspace's AGENTS.md and return its trimmed text, or `""` when
 * the file is present but empty. Throws on any failure (the file is missing
 * — a 404 — or the backend is down / unreachable); the caller catches and
 * leaves its per-conversation cache `undefined` so a later turn retries.
 *
 * Callers cache the successful result on the conversation and only call this
 * when that cache is empty, so a present file is fetched once per
 * conversation (a switched-to conversation reuses its cached copy; a fresh
 * one fetches its own). A present-but-empty file caches as `""` (falsy, so it
 * contributes nothing to the prompt) rather than re-fetching every turn; only
 * a failed fetch stays uncached.
 */
async function loadAgentsMd(): Promise<string> {
  const file = await getFile(AGENTS_MD_PATH);
  return file.content.trim();
}

/**
 * Format the cached AGENTS.md text for the system prompt: a fixed lead-in
 * marking it as the project's own agent instructions, followed by the file's
 * content verbatim.
 */
function formatAgentsMd(text: string): string {
  return (
    "\n\nThe workspace root contains an AGENTS.md file with the " +
    "project's own agent instructions (setup, conventions, commands, and " +
    `pitfalls). Follow it:\n\n${text}`
  );
}

/**
 * The system prompt for one turn: the active profile's own base text, with a
 * note appended for any tools the profile doesn't allow, the startup hook's
 * (cached) output, this turn's fresh hook output, the names of other profiles
 * available for create_subagent delegation, and the workspace's cached
 * AGENTS.md instructions — each only when present, so a profile with none of
 * these produces a prompt byte-identical to its own base text (the
 * request's prefix, and thus the KV cache, is unchanged for an unaffected
 * profile).
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
  if (ctx.deferred && ctx.deferred.length > 0) {
    text +=
      "\n\nThese tools are not loaded up front: " +
      `${ctx.deferred.join(", ")}. To use one, first call search_tools with ` +
      "keywords (or select:name) to get its parameter schema, then run it " +
      "with call_tool, passing its name and arguments.";
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
  if (ctx.agentsMd) {
    text += formatAgentsMd(ctx.agentsMd);
  }
  if (ctx.skillSummaries && ctx.skillSummaries.length > 0) {
    text +=
      "\n\nThe following skills are available. Each is a named block of " +
      "domain instructions that can be loaded into context with the " +
      "use_skill tool, passing the skill's name as the `name` argument. " +
      "Call use_skill when a task clearly falls within a skill's stated " +
      "purpose; do not call it otherwise. The name is what you pass to " +
      "use_skill — the summary describes when to use it:\n" +
      ctx.skillSummaries.map((s) => `- ${s}`).join("\n");
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

/** Maximum tool-call rounds a subagent may run before it must give a final answer. */
const SUBAGENT_MAX_TOOL_TURNS = 5;

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

/** The outcome of resolving one model tool call. */
interface ToolCallOutcome {
  result: string;
  /** Images the tool returned (data URLs), e.g. a browser screenshot. */
  images?: string[];
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
 * use_skill looks up a named skill in the skill store and returns its
 * content (a missing skill is a model-readable error listing the available
 * names); everything else is forwarded to the backend.
 */
async function resolveToolCall(
  rawTc: LlmToolCall,
  model: string,
  profile: Profile,
  profiles: ProfileStore,
  view: MessageView,
  agentsMd: string | undefined,
  skills: SkillStore
): Promise<ToolCallOutcome> {
  // call_tool stands for the deferred tool it names; resolve that instead.
  const unwrapped = unwrapCallTool(rawTc);
  if (typeof unwrapped === "string") return { result: unwrapped };
  const tc = unwrapped;
  const name = tc.function.name;
  const disabled = disabledFromAllowed(profile.allowedTools);
  if (disabled.includes(name)) {
    return { result: disabledToolResult(name, profile.name) };
  }
  if (name === "search_tools") {
    return { result: searchToolsResult(tc, profile.allowedTools) };
  }
  if (name === "use_skill") {
    const args = parseUseSkillArgs(tc);
    if (args === undefined) {
      return {
        result:
          "use_skill requires a `name` argument: the exact name of the " +
          "skill to load, as listed in the system prompt.",
      };
    }
    const skill = skills.getSkill(args);
    if (!skill) {
      const available = skills.getSkills().map((s) => s.name);
      return {
        result:
          `No skill named "${args}". Available skills: ` +
          (available.length > 0 ? available.join(", ") : "(none)") +
          ". Pass one of those exact names to use_skill.",
      };
    }
    return { result: skill.content };
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
    const { result, steps } = await runSubagent(task, model, target, agentsMd);
    return { result, steps, task };
  }
  return executeLlmToolWithImages(tc);
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
  profile: Profile,
  agentsMd?: string
): Promise<{ result: string; steps: SubagentStep[] }> {
  const tools = subagentToolDefs(profile.allowedTools);
  const disabled = disabledFromAllowed(profile.allowedTools);
  const steps: SubagentStep[] = [];
  const messages: LlmMessage[] = [
    { role: "system", content: profile.systemPrompt },
    { role: "user", content: task },
  ];
  const hookOutput = profile.hookCommand
    ? await runHookCommand(profile.hookCommand)
    : undefined;
  // A subagent runs under the same tool-turn budget as its profile's main
  // loop, but headless: it has no user to ask for more rounds, so it simply
  // stops at the cap (falling back to SUBAGENT_MAX_TOOL_TURNS only when the
  // profile predates the field).
  const maxToolTurns = profile.maxToolTurns ?? SUBAGENT_MAX_TOOL_TURNS;
  for (let i = 0; i < maxToolTurns; i++) {
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
        agentsMd,
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
 * One edit_file call within a single streaming round whose live diff preview
 * has been requested from the file viewer (see `handleEditAnimChunk`).
 * Presence in the tracking map means `beginEditDiff` was called exactly
 * once for this index; `active` resolves to whether the viewer actually
 * took over — only then does the plain tool-call label get skipped in favor
 * of the live preview.
 */
interface EditAnimTrack {
  active: Promise<boolean>;
}

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
  fileViewer: FileViewerHandle | undefined,
  send: HTMLButtonElement,
  model: string,
  text: string,
  showActive: () => void,
  signal: AbortSignal,
  skills: SkillStore
): Promise<void> {
  const conv = store.getActive();
  const profile = profiles.getProfile(conv.profileId) ?? profiles.getDefault();
  // The workspace's AGENTS.md, loaded once per conversation and cached on
  // the conversation itself (a switched-to conversation reuses its cached
  // copy; a fresh one fetches its own). A failed fetch (file missing,
  // backend down) is swallowed: the cache stays undefined so a later turn
  // can retry, and the prompt simply lacks the file this turn.
  if (conv.agentsMd === undefined) {
    try {
      conv.agentsMd = await loadAgentsMd();
    } catch {
      // Leave conv.agentsMd undefined so the next turn retries.
    }
  }
  const agentsMd = conv.agentsMd;
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
  resolvePendingApproval();
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
      fileViewer,
      text,
      store.getContextWindow(model),
      store.getPromptTokens(conv.id),
      signal,
      skills,
      turnOutput,
      agentsMd
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

/**
 * Feed one streamed chunk of a tool call's accumulated name/arguments into
 * the live edit_file diff preview in the file viewer, if it is (or might
 * become) one. Gated on `path`/`start_line` resolving — `end_line` may
 * genuinely be omitted (defaults to `start_line`, a pure insert), which is
 * indistinguishable mid-stream from "hasn't arrived yet," so that case waits
 * for the `content` key to appear (a required field every call has) before
 * treating the omission as final. The model is not guaranteed to emit these
 * fields in the schema's declared order (verified live: one local model
 * emitted `content` before `start_line`), so nothing here assumes one —
 * `extractPartialJsonNumber`'s trailing-delimiter check makes it safe to
 * probe for a field on every chunk regardless of where it lands. This is
 * still only a best-effort guess, though: a model that also orders
 * `end_line` *after* `content` (verified live, separately from the
 * `start_line` case above) makes the omission check fire prematurely and
 * locks in the wrong range for the live portion of the preview.
 * `resyncEditDiff` is what guarantees the *settled* preview is always
 * correct, by re-deriving the true values once the call is fully known.
 *
 * `beginEditDiff` is async (it fetches the file), so the first chunk that
 * qualifies kicks it off and records the pending call in `tracks`; every
 * chunk after that (including this same one) streams the call's `content`
 * so far into the diff's green side once — and only once — that promise
 * resolves `true` (the viewer actually took over; `false` means it couldn't,
 * e.g. an unsaved edit failed to flush, and this call gets no live preview).
 */
function handleEditAnimChunk(
  fileViewer: FileViewerHandle,
  tracks: Map<number, EditAnimTrack>,
  index: number,
  name: string,
  args: string
): void {
  if (name !== "edit_file") return;
  const existing = tracks.get(index);
  if (existing) {
    void existing.active.then((active) => {
      if (active) {
        fileViewer.updateEditDiffNew(extractPartialJsonString(args, "content"));
      }
    });
    return;
  }
  const path = extractPartialJsonString(args, "path");
  const startLine = extractPartialJsonNumber(args, "start_line");
  if (!path || startLine === undefined) return;
  let endLine = extractPartialJsonNumber(args, "end_line");
  if (endLine === undefined) {
    if (!args.includes('"content"')) return;
    endLine = startLine;
  }
  tracks.set(index, {
    active: fileViewer.beginEditDiff(path, startLine, endLine),
  });
}

/**
 * Re-derive an edit_file call's real `path`/`start_line`/`end_line`/
 * `content` from its now-fully-arrived (and therefore always valid) JSON
 * arguments, and re-open the live diff against them — correcting any wrong
 * guess `handleEditAnimChunk` made while the call was still streaming (see
 * its doc comment: the model is not guaranteed to emit these fields in the
 * schema's order, and `end_line`'s absence is genuinely ambiguous — omitted
 * vs. simply not arrived yet — until more of the call has streamed in).
 * Malformed arguments are left as whatever the live guess produced; the
 * backend will reject the call with a clear error regardless, and that
 * error still reaches the transcript normally once the call executes.
 */
async function resyncEditDiff(
  fileViewer: FileViewerHandle,
  tc: LlmToolCall
): Promise<boolean> {
  let args: {
    path?: unknown;
    start_line?: unknown;
    end_line?: unknown;
    content?: unknown;
  };
  try {
    args = JSON.parse(tc.function.arguments) as typeof args;
  } catch {
    return true;
  }
  if (typeof args.path !== "string" || typeof args.start_line !== "number") {
    return true;
  }
  const startLine = Math.trunc(args.start_line);
  const endLine =
    typeof args.end_line === "number" ? Math.trunc(args.end_line) : startLine;
  const active = await fileViewer.beginEditDiff(args.path, startLine, endLine);
  if (active && typeof args.content === "string") {
    fileViewer.updateEditDiffNew(args.content);
  }
  return active;
}

async function runTurn(
  store: ConversationStore,
  profiles: ProfileStore,
  profile: Profile,
  model: string,
  view: MessageView,
  fileViewer: FileViewerHandle | undefined,
  userText: string,
  cap: number | undefined,
  lastPromptTokens: number | undefined,
  signal: AbortSignal,
  skills: SkillStore,
  turnOutput?: string,
  agentsMd?: string
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
    // The per-profile tool-turn budget. When the loop reaches it, the user is
    // asked whether to allow more rounds; each approval extends the budget by
    // the same amount, so a turn that keeps working runs until the user
    // declines or the model produces a final answer.
    const maxToolTurns = profile.maxToolTurns ?? MAX_TOOL_TURNS;
    const skillSummaries = skills
      .getSkills()
      .filter((s) => s.summary !== "")
      .map((s) => `${s.name}: ${s.summary}`);
    for (let i = 0; ; i++) {
      // The model used up its budget (maxToolTurns rounds) without producing
      // a final answer. We reach here at the start of each new budget segment
      // (i = maxToolTurns, 2*maxToolTurns, …) after the previous segment
      // ended on tool calls. Ask whether to allow more rounds; a "yes" lets
      // the loop continue for another full segment, a "no" — or an abandoned
      // card, which counts as a "no" — falls off the loop to the dead-end
      // message below. (i > 0 skips the first segment, which runs without
      // asking.)
      if (i > 0 && i % maxToolTurns === 0 && !(await requestMoreRounds(view))) {
        break;
      }
      const messages = buildMessages(history, {
        base: profile.systemPrompt,
        disabled,
        deferred: DEFERRED_TOOL_NAMES.filter((n) => !disabled.includes(n)),
        hookOutput,
        turnOutput,
        profileNames,
        agentsMd,
        skillSummaries,
      });
      let streamingStarted = false;
      const ensureStreamingStarted = (): void => {
        if (!streamingStarted) {
          view.beginStreaming();
          view.clearNotice();
          streamingStarted = true;
        }
      };
      // Tracks edit_file calls previewed live in the file viewer as this
      // round's tool_calls stream in (see handleEditAnimChunk), keyed by the
      // call's index within this one streamLlmMessage invocation.
      const editAnimTracks = new Map<number, EditAnimTrack>();
      const reply = await streamLlmMessage(
        messages,
        model,
        offeredToolsFor(disabled),
        (text) => {
          ensureStreamingStarted();
          view.updateStreaming(text);
        },
        (reasoning) => {
          ensureStreamingStarted();
          view.updateReasoning(reasoning);
        },
        fileViewer &&
          ((index, name, args) => {
            handleEditAnimChunk(fileViewer, editAnimTracks, index, name, args);
          }),
        signal
      );
      lastUsage = reply.usage ?? lastUsage;
      abortIfSwitched();
      if (signal.aborted) {
        // The user clicked Stop: finalize now with whatever text (if any)
        // was generated before the abort, skipping any tool calls the reply
        // may have (possibly incomplete, mid-stream) and the end-of-turn
        // hook check, which would otherwise fight the user's stop. Reload
        // any file the diff preview opened — the edit never actually ran,
        // so leaving its unfinished green side up would misleadingly imply
        // it did.
        view.endStreaming();
        if (editAnimTracks.size > 0) void fileViewer?.cancelEditDiff();
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
        // An edit_file call whose live diff preview actually took over the
        // file viewer gets no plain tool-call label — the preview already
        // shows what it's doing — falling back to the normal label for
        // everything else (including an edit_file call the preview never
        // managed to open, e.g. an unsaved manual edit that failed to flush).
        const active = new Map<number, boolean>();
        for (let ti = 0; ti < reply.tool_calls.length; ti++) {
          const tc = reply.tool_calls[ti];
          const track = editAnimTracks.get(ti);
          let isActive = track ? await track.active : false;
          // The live guess (handleEditAnimChunk) may have read start_line/
          // end_line wrong if the model streamed them out of the schema's
          // order — now that the call is fully known, re-derive the real
          // values and re-open the diff against them before the tool
          // actually runs (once it does, the pre-edit file is gone, so this
          // is the last point a correction can use the real "before" text).
          if (isActive && fileViewer) {
            isActive = await resyncEditDiff(fileViewer, tc);
          }
          active.set(ti, isActive);
        }
        reply.tool_calls.forEach((tc, ti) => {
          if (!active.get(ti)) view.appendToolCall(toolCallLabel(tc));
        });
        for (let ti = 0; ti < reply.tool_calls.length; ti++) {
          const tc = reply.tool_calls[ti];
          const outcome = await resolveToolCall(
            tc,
            model,
            profile,
            profiles,
            view,
            agentsMd,
            skills
          );
          abortIfSwitched();
          history.push({
            role: "tool",
            content: outcome.result,
            tool_call_id: tc.id,
            ...(outcome.images?.length ? { images: outcome.images } : {}),
          });
          if (outcome.steps) {
            view.appendSubagentResult(
              outcome.task ?? "",
              outcome.steps,
              outcome.result
            );
          } else if (active.get(ti)) {
            // The call already ran (resolveToolCall awaited above): settle
            // the preview (stop the cursor, show the outcome) and leave it
            // up until the user dismisses it via its own OK button. A
            // failure also surfaces the actual reason the same way every
            // other tool failure does, since the settled preview only says
            // "Edit failed" with no detail.
            const ok = !outcome.result.startsWith("Error:");
            fileViewer?.endEditDiff(ok);
            if (!ok) view.appendToolResult(outcome.result);
          } else {
            view.appendToolResult(outcome.result, outcome.images);
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
    void fileViewer?.cancelEditDiff();
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
  const { reasoning: _reasoning, images: _images, ...wire } = m;
  return wire;
}

/**
 * Convert stored messages to wire form, delivering tool-returned images the
 * only way the chat protocol allows: a `tool` message's content must be text,
 * so the images go in a synthetic `user` message placed right after the last
 * tool message of that group (never between an assistant's tool calls and
 * their results). Only the most recent images are sent — older screenshots
 * are dropped from the prompt, since images are expensive in tokens.
 */
function toWireMessages(messages: ChatMessage[]): LlmMessage[] {
  let latest = -1;
  messages.forEach((m, i) => {
    if (m.role === "tool" && m.images?.length) latest = i;
  });
  const out: LlmMessage[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    out.push({
      role: "user",
      content: [
        { type: "text", text: "Image(s) returned by the tool call above:" },
        ...pending.map(
          (url): LlmContentPart => ({ type: "image_url", image_url: { url } })
        ),
      ],
    });
    pending = [];
  };
  messages.forEach((m, i) => {
    if (m.role !== "tool") flush();
    out.push(toWireMessage(m));
    if (i === latest) pending = m.images ?? [];
  });
  flush();
  return out;
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
    messages.push(...toWireMessages(history.slice(cut + 1)));
  } else {
    messages.push(...toWireMessages(history));
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
