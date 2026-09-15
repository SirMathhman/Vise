import {
  executeLlmTool,
  type LlmMessage,
  type LlmToolCall,
  listLlmModels,
  sendLlmMessage,
} from "../api/client.js";
import { llmToolDefinitions } from "../llm/tools.js";

/** localStorage keys for the persisted conversation and model choice. */
const STORAGE_HISTORY = "vise:llm:history";
const STORAGE_MODEL = "vise:llm:model";

/** Persist the conversation and the selected model across page reloads. */
function saveState(history: LlmMessage[], model: string): void {
  try {
    localStorage.setItem(STORAGE_HISTORY, JSON.stringify(history));
    localStorage.setItem(STORAGE_MODEL, model);
  } catch {
    // Storage may be unavailable (private mode, quota); persistence is a
    // best-effort enhancement, so failures are ignored.
  }
}

/** Restore the persisted conversation, or an empty one on failure. */
function loadHistory(): LlmMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is LlmMessage =>
        typeof m === "object" &&
        m !== null &&
        (m as LlmMessage).role in
          {
            user: true,
            assistant: true,
            tool: true,
          } &&
        (typeof (m as LlmMessage).content === "string" ||
          (m as LlmMessage).content === null)
    );
  } catch {
    return [];
  }
}

function loadModel(): string {
  try {
    return localStorage.getItem(STORAGE_MODEL) ?? "";
  } catch {
    return "";
  }
}

/**
 * Wire up the LLM panel. Loads the model list into the selector and connects
 * the Send button (and Ctrl/Cmd+Enter) to a chat completion that renders the
 * full conversation into the response list. Clear resets the history. The
 * conversation and selected model persist across page reloads via
 * localStorage.
 */
export function setupLlm(root: HTMLElement): void {
  const model = root.querySelector<HTMLSelectElement>("#llm-model");
  const prompt = root.querySelector<HTMLTextAreaElement>("#llm-prompt");
  const response = root.querySelector<HTMLElement>("#llm-response");
  const send = root.querySelector<HTMLButtonElement>("#llm-send");
  const clear = root.querySelector<HTMLButtonElement>("#llm-clear");
  if (!model || !prompt || !response || !send) return;

  const history: LlmMessage[] = loadHistory();
  const savedModel = loadModel();
  if (history.length === 0) {
    setLlmHint(response, "Start a conversation.");
  } else {
    // Drop the static "Start a conversation." hint from the markup, then
    // re-render the restored conversation.
    response.innerHTML = "";
    for (const m of history) {
      renderHistoryMessage(response, m);
    }
  }

  listLlmModels()
    .then((models) => {
      if (models.length === 0) {
        setLlmHint(response, "No models served.");
        return;
      }
      model.innerHTML = models
        .map((m) => `<option value="${m.id}">${m.id}</option>`)
        .join("");
      // Restore the saved choice if the proxy still serves it; otherwise
      // fall back to the proxy's default (first option).
      if (savedModel && models.some((m) => m.id === savedModel)) {
        model.value = savedModel;
      }
    })
    .catch((e: unknown) =>
      setLlmError(
        response,
        `Failed to load models: ${e instanceof Error ? e.message : e}`
      )
    );

  const submit = () => {
    const text = prompt.value.trim();
    const m = model.value;
    if (!text || !m) return;
    prompt.value = "";
    send.disabled = true;
    setLlmHint(response, "Thinking…");
    void runTurn(history, m, response, text)
      .then((reply) => {
        removeHint(response);
        renderMessage(response, "assistant", reply);
        saveState(history, model.value);
      })
      .catch((e: unknown) => {
        setLlmError(
          response,
          `Request failed: ${e instanceof Error ? e.message : e}`
        );
      })
      .finally(() => {
        send.disabled = false;
      });
  };

  const doClear = () => {
    history.length = 0;
    response.innerHTML = "";
    setLlmHint(response, "Start a conversation.");
    saveState(history, model.value);
  };

  send.addEventListener("click", submit);
  clear?.addEventListener("click", doClear);
  model.addEventListener("change", () => saveState(history, model.value));
  prompt.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
  });
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
  "You are a helpful assistant that can inspect a file tree. To answer " +
  "questions about what files or directories exist, call the list_directory " +
  'tool with the directory path relative to the root (use "" for the root), ' +
  "and base your answer on the tool's result.";

async function runTurn(
  history: LlmMessage[],
  model: string,
  response: HTMLElement,
  userText: string
): Promise<string> {
  const preLength = history.length;
  const domBefore = response.childElementCount;
  try {
    history.push({ role: "user", content: userText });
    renderMessage(response, "user", userText);
    for (let i = 0; i < MAX_TOOL_TURNS; i++) {
      const messages: LlmMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
      ];
      const reply = await sendLlmMessage(messages, model, llmToolDefinitions);
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
      return text;
    }
    const text =
      "I stopped after several directory lookups without a final answer.";
    history.push({ role: "assistant", content: text });
    return text;
  } catch (err) {
    history.length = preLength;
    while (response.childElementCount > domBefore) {
      response.lastElementChild?.remove();
    }
    throw err;
  }
}

function toolCallLabel(tc: LlmToolCall): string {
  return `${tc.function.name}(${tc.function.arguments})`;
}

function renderHistoryMessage(response: HTMLElement, m: LlmMessage): void {
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
