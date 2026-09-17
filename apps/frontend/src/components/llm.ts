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
} from "../api/client.js";
import { llmToolDefinitions } from "../llm/tools.js";
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

/**
 * Wire up the LLM panel. Manages a list of conversations (each with its own
 * message history and model choice) that persist across page reloads: the
 * user can start a new conversation (New), switch back to an old one via the
 * conversation dropdown, and continue each of them. The Send button (and
 * Ctrl/Cmd+Enter) runs a chat completion for the active conversation.
 */
export function setupLlm(root: HTMLElement): void {
  const conversation =
    root.querySelector<HTMLSelectElement>("#llm-conversation");
  const model = root.querySelector<HTMLSelectElement>("#llm-model");
  const prompt = root.querySelector<HTMLTextAreaElement>("#llm-prompt");
  const response = root.querySelector<HTMLElement>("#llm-response");
  const send = root.querySelector<HTMLButtonElement>("#llm-send");
  const newBtn = root.querySelector<HTMLButtonElement>("#llm-new");
  const deleteBtn = root.querySelector<HTMLButtonElement>("#llm-delete");
  const context = root.querySelector<HTMLElement>("#llm-context");
  const hook = root.querySelector<HTMLInputElement>("#llm-hook");
  const turnHook = root.querySelector<HTMLInputElement>("#llm-turn-hook");
  const endHook = root.querySelector<HTMLInputElement>("#llm-end-hook");
  if (
    !conversation ||
    !model ||
    !prompt ||
    !response ||
    !send ||
    !context ||
    !hook ||
    !turnHook ||
    !endHook
  ) {
    return;
  }

  const store = createConversationStore();
  const view = new MessageView(response);
  window.addEventListener("resize", () => view.refresh());

  const tools = root.querySelector<HTMLElement>("#llm-tools");
  if (tools) renderToolList(tools, store);

  const renderContext = () => renderContextText(context, model, store);

  const renderConversationList = () => {
    conversation.innerHTML = store
      .getConversations()
      .map((c) => `<option value="${c.id}">${escapeHtml(c.title)}</option>`)
      .join("");
    conversation.value = store.activeId();
  };

  const renderActiveMessages = () => {
    const conv = store.getActive();
    view.clearNotice();
    view.setMessages(conv.messages);
    if (conv.messages.length === 0) {
      view.setNotice("hint", "Start a conversation.");
    }
  };

  const showActive = () => {
    renderConversationList();
    const conv = store.getActive();
    model.value = conv.model;
    hook.value = conv.hookCommand;
    // Once the conversation has started, the hook (if any) has already run
    // (or never will), so the field is shown read-only for reference.
    hook.disabled = conv.messages.length > 0;
    turnHook.value = conv.turnCommand;
    endHook.value = conv.endCommand;
    renderActiveMessages();
    renderContext();
    if (tools) syncToolList(tools, store);
  };

  showActive();

  loadModelList(model, view, store);

  const submit = () => {
    const text = prompt.value.trim();
    const m = model.value;
    if (!text || !m) return;
    prompt.value = "";
    void submitTurn(store, view, send, m, text, showActive);
  };

  const doNew = () => {
    // The previous conversation stays in the list so it can be reopened.
    store.newConversation(model.value);
    showActive();
    store.persist();
    prompt.focus();
  };

  const doDelete = () => {
    store.deleteConversation(store.activeId());
    showActive();
    store.persist();
    prompt.focus();
  };

  const switchConversation = (id: string) => {
    store.switchTo(id);
    showActive();
    store.persist();
  };

  send.addEventListener("click", submit);
  newBtn?.addEventListener("click", doNew);
  deleteBtn?.addEventListener("click", doDelete);
  conversation.addEventListener("change", () =>
    switchConversation(conversation.value)
  );
  model.addEventListener("change", () => {
    store.setActiveModel(model.value);
    store.persist();
  });
  hook.addEventListener("change", () => {
    store.setHookCommand(hook.value);
    store.persist();
  });
  turnHook.addEventListener("change", () => {
    store.setTurnCommand(turnHook.value);
    store.persist();
  });
  endHook.addEventListener("change", () => {
    store.setEndCommand(endHook.value);
    store.persist();
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

const SYSTEM_PROMPT =
  "You are a helpful assistant that can inspect and modify files in a " +
  "workspace. To see what exists, call list_directory with the directory " +
  'path relative to the root (use "" for the root). To read a file, call ' +
  "read_file with the path and a 1-based line range (start_line inclusive, " +
  "end_line exclusive). To edit an existing file, call edit_file with the " +
  "path, a 1-based line range (start_line inclusive, end_line exclusive), and " +
  "the replacement content; always read_file first so you know the exact lines " +
  "to replace. To create new files or directories, call create_file or " +
  "create_directory. To run a PowerShell command (builds, git, typecheck, " +
  "file operations, etc.), call run_command with the command; it runs in the " +
  "workspace root and returns its output and exit status. To delegate a " +
  "self-contained sub-task to an independent helper (e.g. a focused search or " +
  "fix that doesn't need this conversation's context), call create_subagent " +
  "with a clear task description; it returns the helper's final answer. Base " +
  "your answer on the tools' results.";

/**
 * The system prompt, with a note appended when the user has disabled some
 * tools, and/or the startup hook's (cached) output, and/or this turn's hook
 * output appended. With none of these, it is exactly SYSTEM_PROMPT, so the
 * request's prefix (and thus the KV cache) is unchanged for unaffected
 * conversations.
 */
function systemPrompt(
  disabled: string[],
  hookOutput?: string,
  turnOutput?: string
): string {
  let text = SYSTEM_PROMPT;
  if (disabled.length > 0) {
    text +=
      ` The following tools are disabled by the user and must not be called: ` +
      `${disabled.join(", ")}. If a task needs one of them, tell the user it ` +
      "is disabled and ask them to enable it in the Tools list.";
  }
  if (hookOutput) {
    text +=
      "\n\nBefore this conversation began, the following startup command " +
      `was run in the workspace and produced this output:\n${hookOutput}`;
  }
  if (turnOutput) {
    text +=
      "\n\nJust before this turn, the following turn command was run in " +
      `the workspace and produced this output:\n${turnOutput}`;
  }
  return text;
}

/**
 * Run a conversation's startup hook command through the same run_command
 * tool the model uses, and return its output (including error text — the
 * backend resolves failures to an "Error: …" string rather than throwing).
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

/** Model-readable result returned when the model calls a disabled tool. */
function disabledToolResult(name: string): string {
  return (
    `${name} is disabled by the user. Do not call it; if you need its ` +
    "capability, tell the user it is disabled and ask them to enable it."
  );
}

/** Maximum tool-call rounds a subagent may run before it must give a final answer. */
const SUBAGENT_MAX_TOOL_TURNS = 5;

const SUBAGENT_SYSTEM_PROMPT =
  "You are a helper agent given a single, self-contained task by another " +
  "assistant. You have no memory of any other conversation — only the task " +
  "below. Use the available tools to complete it, then reply with plain text " +
  "stating the outcome; that text is the only thing the calling assistant " +
  "will see.";

/**
 * The tools available to a subagent: every tool the parent conversation has
 * (respecting its disabled list, checked separately in runSubagent) except
 * create_subagent itself, so a subagent cannot spawn further subagents.
 */
function subagentTools(): LlmTool[] {
  return llmToolDefinitions.filter(
    (t) => t.function.name !== "create_subagent"
  );
}

/** Parse the `task` argument out of a create_subagent tool call. */
function parseSubagentTask(tc: LlmToolCall): string {
  try {
    const args = JSON.parse(tc.function.arguments) as { task?: unknown };
    return typeof args.task === "string" ? args.task : "";
  } catch {
    return "";
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
 * Resolve a single tool call to its model-readable result. Disabled tools are
 * short-circuited client-side; create_subagent runs its own nested loop
 * (see runSubagent); everything else is forwarded to the backend.
 */
async function resolveToolCall(
  tc: LlmToolCall,
  model: string,
  disabled: string[]
): Promise<ToolCallOutcome> {
  const name = tc.function.name;
  if (disabled.includes(name)) return { result: disabledToolResult(name) };
  if (name === "create_subagent") {
    const task = parseSubagentTask(tc);
    const { result, steps } = await runSubagent(task, model, disabled);
    return { result, steps, task };
  }
  return { result: await executeLlmTool(tc) };
}

/**
 * Run an independent, bounded tool-calling loop for a single delegated task.
 * The subagent gets its own message history (just the task, not the parent
 * conversation) and the same tool-enablement the parent has, minus
 * create_subagent itself (so nesting stops at one level). Nothing here is
 * persisted to the conversation store; only the final result and the step
 * trace (for the collapsed transcript block) are returned to the caller.
 */
async function runSubagent(
  task: string,
  model: string,
  disabled: string[]
): Promise<{ result: string; steps: SubagentStep[] }> {
  const tools = subagentTools();
  const steps: SubagentStep[] = [];
  const messages: LlmMessage[] = [
    { role: "system", content: SUBAGENT_SYSTEM_PROMPT },
    { role: "user", content: task },
  ];
  for (let i = 0; i < SUBAGENT_MAX_TOOL_TURNS; i++) {
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
          ? disabledToolResult(name)
          : await executeLlmTool(tc);
        messages.push({ role: "tool", content: result, tool_call_id: tc.id });
        steps.push({ kind: "tool-result", text: result });
      }
      continue;
    }
    return { result: reply.content ?? "", steps };
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
  usage?: LlmUsage;
}

/**
 * Run one submit end to end: the conversation's startup hook (first message
 * only, cached), then its per-turn hook (every turn, run fresh and never
 * cached), then the model turn — updating the view/store/send-button state
 * throughout. Extracted out of `setupLlm` so that closure stays a thin
 * wiring function.
 */
async function submitTurn(
  store: ConversationStore,
  view: MessageView,
  send: HTMLButtonElement,
  model: string,
  text: string,
  showActive: () => void
): Promise<void> {
  const conv = store.getActive();
  const hookCommand = conv.hookCommand.trim();
  const needsHook =
    conv.messages.length === 0 &&
    hookCommand !== "" &&
    conv.hookOutput === undefined;
  const turnCommand = conv.turnCommand.trim();
  const endCommand = conv.endCommand.trim();
  send.disabled = true;
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
      model,
      view,
      text,
      store.getContextWindow(model),
      store.getPromptTokens(conv.id),
      turnOutput,
      endCommand
    );
    view.clearNotice();
    view.appendMessage({ role: "assistant", content: result.text });
    store.commitTurn(result.usage);
    showActive();
  } catch (e) {
    view.setNotice(
      "error",
      `Request failed: ${e instanceof Error ? e.message : e}`
    );
  } finally {
    send.disabled = false;
  }
}

async function runTurn(
  store: ConversationStore,
  model: string,
  view: MessageView,
  userText: string,
  cap: number | undefined,
  lastPromptTokens: number | undefined,
  turnOutput?: string,
  endCommand?: string
): Promise<TurnResult> {
  const history = store.getActive().messages;
  const preLength = history.length;
  const disabled = store.getDisabledTools();
  const hookOutput = store.getActive().hookOutput;
  let lastUsage: LlmUsage | undefined;
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
      if (summary) {
        store.appendMessage({
          role: "user",
          content: summary,
          compaction: true,
        });
        view.appendCompaction();
      }
    }
    store.appendMessage({ role: "user", content: userText });
    view.appendMessage({ role: "user", content: userText });
    for (let i = 0; i < MAX_TOOL_TURNS; i++) {
      const messages = buildMessages(history, disabled, hookOutput, turnOutput);
      const reply = await sendLlmMessage(messages, model, llmToolDefinitions);
      lastUsage = reply.usage ?? lastUsage;
      if (reply.tool_calls && reply.tool_calls.length > 0) {
        store.appendMessage({
          role: "assistant",
          content: reply.content,
          tool_calls: reply.tool_calls,
        });
        for (const tc of reply.tool_calls) {
          view.appendToolCall(toolCallLabel(tc));
        }
        for (const tc of reply.tool_calls) {
          const outcome = await resolveToolCall(tc, model, disabled);
          store.appendMessage({
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
      store.appendMessage({ role: "assistant", content: text });
      if (endCommand) {
        // A thrown failure here (spawn error, or the backend's single-flight
        // guard colliding with another in-flight command) is an
        // infrastructure problem, not the checked command's own stderr — it
        // must not fall through to this turn's outer catch, which would roll
        // back the whole turn's persisted history (including any file
        // mutations the model's own tool calls already made, which the
        // rollback cannot undo). Treat it the same as a blocking check: show
        // it, tell the model, and loop.
        let check: ShellCommandResult;
        try {
          check = await runShellCommand(endCommand);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const summary = `End-of-turn check: $ ${endCommand}\ncould not run: ${message}`;
          view.appendMessage({ role: "assistant", content: text });
          view.appendEndHookResult(summary);
          store.appendMessage({
            role: "user",
            content: `The end-of-turn check command could not be run (${message}). Reply again.`,
            endHook: true,
          });
          continue;
        }
        const summary = formatEndHookOutput(endCommand, check);
        if (check.stderr) {
          // This reply is rejected: show it and the check's output now (it
          // will never be rendered as the turn's final answer), record a
          // protocol-valid retry turn so the model sees why, and loop.
          view.appendMessage({ role: "assistant", content: text });
          view.appendEndHookResult(summary);
          store.appendMessage({
            role: "user",
            content: endHookRetryMessage(endCommand, check),
            endHook: true,
          });
          continue;
        }
        view.appendEndHookResult(summary);
      }
      return { text, usage: lastUsage };
    }
    const text =
      "I stopped after several directory lookups without a final answer.";
    store.appendMessage({ role: "assistant", content: text });
    return { text, usage: lastUsage };
  } catch (err) {
    store.rollbackTo(preLength);
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
 * Build the outgoing prompt: the system prompt, then the latest compaction
 * summary (if any) in place of the pre-summary history, then the turns after
 * it. Without a compaction the full history is sent.
 */
function buildMessages(
  history: ChatMessage[],
  disabled: string[] = [],
  hookOutput?: string,
  turnOutput?: string
): LlmMessage[] {
  let cut = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].compaction) {
      cut = i;
      break;
    }
  }
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt(disabled, hookOutput, turnOutput) },
  ];
  if (cut >= 0) {
    messages.push({ role: "user", content: history[cut].content ?? "" });
    for (let i = cut + 1; i < history.length; i++) messages.push(history[i]);
  } else {
    for (const m of history) messages.push(m);
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
  // prompt differs (the summary brief instead of the tool instructions).
  const compacted = buildMessages(history);
  const messages: LlmMessage[] = [
    { role: "system", content: SUMMARY_PROMPT },
    ...compacted.slice(1),
  ];
  const reply = await sendLlmMessage(messages, model);
  return (reply.content ?? "").trim();
}

/**
 * Render the available tools into the panel, each with an enable/disable
 * checkbox. A disabled tool is dimmed; its state is per-conversation (see the
 * store) and is forwarded to the model via the system prompt.
 */
function renderToolList(
  container: HTMLElement,
  store: ConversationStore
): void {
  const details = document.createElement("details");
  details.className = "llm-tools";
  const title = document.createElement("summary");
  title.className = "llm-tools-title";
  title.textContent = "Tools";
  const list = document.createElement("ul");
  list.className = "llm-tools-list";
  for (const tool of llmToolDefinitions) {
    const name = tool.function.name;
    const li = document.createElement("li");
    li.className = "llm-tool";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "llm-tool-toggle";
    cb.value = name;
    cb.checked = !store.getDisabledTools().includes(name);
    cb.addEventListener("change", () => {
      store.setToolEnabled(name, cb.checked);
      store.persist();
      setToolRow(li, cb.checked);
    });
    const body = document.createElement("div");
    body.className = "llm-tool-body";
    const codeEl = document.createElement("code");
    codeEl.className = "llm-tool-name";
    codeEl.textContent = name;
    const desc = document.createElement("span");
    desc.className = "llm-tool-desc";
    desc.textContent = tool.function.description;
    body.append(codeEl, desc);
    li.append(cb, body);
    list.append(li);
  }
  details.append(title, list);
  container.append(details);
}

/** Dim a tool row when disabled, and un-dim it when enabled. */
function setToolRow(li: HTMLElement, enabled: boolean): void {
  li.classList.toggle("llm-tool-disabled", !enabled);
}

/**
 * Re-sync every tool checkbox to the active conversation's disabled set; used
 * when switching conversations so each one shows its own tool state.
 */
function syncToolList(container: HTMLElement, store: ConversationStore): void {
  const disabled = store.getDisabledTools();
  container
    .querySelectorAll<HTMLInputElement>(".llm-tool-toggle")
    .forEach((cb) => {
      const off = disabled.includes(cb.value);
      cb.checked = !off;
      cb.closest(".llm-tool")?.classList.toggle("llm-tool-disabled", off);
    });
}
