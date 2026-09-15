import {
  executeLlmTool,
  type LlmMessage,
  type LlmToolCall,
  type LlmUsage,
  listLlmModels,
  sendLlmMessage,
} from "../api/client.js";
import { llmToolDefinitions } from "../llm/tools.js";
import { type ChatMessage, createConversationStore } from "./conversations.js";

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
  const context = root.querySelector<HTMLElement>("#llm-context");
  if (!conversation || !model || !prompt || !response || !send || !context) {
    return;
  }

  const tools = root.querySelector<HTMLElement>("#llm-tools");
  if (tools) renderToolList(tools);

  const store = createConversationStore();

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
    response.innerHTML = "";
    if (conv.messages.length === 0) {
      setLlmHint(response, "Start a conversation.");
      return;
    }
    for (const m of conv.messages) renderHistoryMessage(response, m);
  };

  const showActive = () => {
    renderConversationList();
    model.value = store.getActive().model;
    renderActiveMessages();
    renderContext();
  };

  showActive();

  loadModelList(model, response, store);

  const submit = () => {
    const text = prompt.value.trim();
    const m = model.value;
    if (!text || !m) return;
    const conv = store.getActive();
    prompt.value = "";
    send.disabled = true;
    setLlmHint(response, "Thinking…");
    void runTurn(
      conv.messages,
      m,
      response,
      text,
      store.getContextWindow(m),
      store.getPromptTokens(conv.id)
    )
      .then((result) => {
        removeHint(response);
        renderMessage(response, "assistant", result.text);
        store.commitTurn(result.usage);
        showActive();
      })
      .catch((e: unknown) =>
        setLlmError(
          response,
          `Request failed: ${e instanceof Error ? e.message : e}`
        )
      )
      .finally(() => {
        send.disabled = false;
      });
  };

  const doNew = () => {
    // The previous conversation stays in the list so it can be reopened.
    store.newConversation(model.value);
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
  conversation.addEventListener("change", () =>
    switchConversation(conversation.value)
  );
  model.addEventListener("change", () => {
    store.setActiveModel(model.value);
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
  response: HTMLElement,
  store: ReturnType<typeof createConversationStore>
): void {
  listLlmModels()
    .then((models) => {
      if (models.length === 0) {
        setLlmHint(response, "No models served.");
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
      setLlmError(
        response,
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
  "workspace root and returns its output and exit status. Base your answer " +
  "on the tools' results.";

/** The outcome of a turn: the assistant text and its final token usage. */
export interface TurnResult {
  text: string;
  usage?: LlmUsage;
}

async function runTurn(
  history: ChatMessage[],
  model: string,
  response: HTMLElement,
  userText: string,
  cap: number | undefined,
  lastPromptTokens: number | undefined
): Promise<TurnResult> {
  const preLength = history.length;
  const domBefore = response.childElementCount;
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
        history.push({ role: "user", content: summary, compaction: true });
        renderCompactionNote(response);
      }
    }
    history.push({ role: "user", content: userText });
    renderMessage(response, "user", userText);
    for (let i = 0; i < MAX_TOOL_TURNS; i++) {
      const messages = buildMessages(history);
      const reply = await sendLlmMessage(messages, model, llmToolDefinitions);
      lastUsage = reply.usage ?? lastUsage;
      if (reply.tool_calls && reply.tool_calls.length > 0) {
        history.push({
          role: "assistant",
          content: reply.content,
          tool_calls: reply.tool_calls,
        });
        for (const tc of reply.tool_calls) {
          renderToolCall(response, toolCallLabel(tc));
        }
        for (const tc of reply.tool_calls) {
          const result = await executeLlmTool(tc);
          history.push({
            role: "tool",
            content: result,
            tool_call_id: tc.id,
          });
          renderToolResult(response, result);
        }
        continue;
      }
      const text = reply.content ?? "";
      history.push({ role: "assistant", content: text });
      return { text, usage: lastUsage };
    }
    const text =
      "I stopped after several directory lookups without a final answer.";
    history.push({ role: "assistant", content: text });
    return { text, usage: lastUsage };
  } catch (err) {
    history.length = preLength;
    while (response.childElementCount > domBefore) {
      response.lastElementChild?.remove();
    }
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
function buildMessages(history: ChatMessage[]): LlmMessage[] {
  let cut = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].compaction) {
      cut = i;
      break;
    }
  }
  const messages: LlmMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
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

/** Render the subtle separator shown where a compaction marker lands. */
function renderCompactionNote(response: HTMLElement): void {
  const note = document.createElement("div");
  note.className = "llm-compaction";
  note.textContent = "— conversation compacted —";
  response.append(note);
  response.scrollTop = response.scrollHeight;
}

function toolCallLabel(tc: LlmToolCall): string {
  return `${tc.function.name}(${tc.function.arguments})`;
}

/** Render the available tools (name + description) into the panel. */
function renderToolList(container: HTMLElement): void {
  const details = document.createElement("details");
  details.className = "llm-tools";
  const title = document.createElement("summary");
  title.className = "llm-tools-title";
  title.textContent = "Tools";
  const list = document.createElement("ul");
  list.className = "llm-tools-list";
  for (const tool of llmToolDefinitions) {
    const li = document.createElement("li");
    const name = document.createElement("code");
    name.className = "llm-tool-name";
    name.textContent = tool.function.name;
    const desc = document.createElement("span");
    desc.className = "llm-tool-desc";
    desc.textContent = tool.function.description;
    li.append(name, desc);
    list.append(li);
  }
  details.append(title, list);
  container.append(details);
}

function renderHistoryMessage(response: HTMLElement, m: ChatMessage): void {
  if (m.compaction) {
    renderCompactionNote(response);
    return;
  }
  if (m.role === "tool") {
    renderToolResult(response, m.content ?? "");
    return;
  }
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    for (const tc of m.tool_calls) renderToolCall(response, toolCallLabel(tc));
    if (m.content) renderMessage(response, "assistant", m.content);
    return;
  }
  if (m.role === "user" || m.role === "assistant") {
    renderMessage(response, m.role, m.content ?? "");
  }
}

function renderToolCall(response: HTMLElement, label: string): void {
  const block = document.createElement("div");
  block.className = "llm-tool";
  const text = document.createElement("span");
  text.className = "llm-tool-label";
  text.textContent = label;
  block.append(text);
  response.append(block);
  response.scrollTop = response.scrollHeight;
}

function renderToolResult(response: HTMLElement, text: string): void {
  const block = document.createElement("div");
  block.className = "llm-tool-result";
  block.textContent = text;
  response.append(block);
  response.scrollTop = response.scrollHeight;
}

function renderMessage(
  response: HTMLElement,
  role: "user" | "assistant",
  content: string
): void {
  const block = document.createElement("div");
  block.className = `llm-msg llm-msg-${role}`;
  const who = document.createElement("span");
  who.className = "llm-msg-role";
  who.textContent = role === "user" ? "You" : "Model";
  const text = document.createElement("span");
  text.className = "llm-msg-text";
  text.textContent = content;
  block.append(who, text);
  response.append(block);
  response.scrollTop = response.scrollHeight;
}

function removeHint(response: HTMLElement): void {
  response
    .querySelectorAll(".llm-hint, .llm-loading, .llm-error")
    .forEach((el) => {
      el.remove();
    });
}

function setLlmHint(response: HTMLElement, text: string): void {
  removeHint(response);
  const span = document.createElement("span");
  span.className = text === "Thinking…" ? "llm-loading" : "llm-hint";
  span.textContent = text;
  response.append(span);
}

function setLlmError(response: HTMLElement, text: string): void {
  removeHint(response);
  const span = document.createElement("span");
  span.className = "llm-error";
  span.textContent = text;
  response.append(span);
}
