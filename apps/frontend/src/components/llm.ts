import {
  type LlmMessage,
  listLlmModels,
  sendLlmMessage,
} from "../api/client.js";

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
        (m as LlmMessage).role in { user: true, assistant: true } &&
        typeof (m as LlmMessage).content === "string"
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
      renderMessage(response, m.role, m.content);
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
    history.push({ role: "user", content: text });
    renderMessage(response, "user", text);
    prompt.value = "";
    saveState(history, m);
    send.disabled = true;
    setLlmHint(response, "Thinking…");
    sendLlmMessage(history, m)
      .then((reply) => {
        history.push({ role: "assistant", content: reply });
        removeHint(response);
        renderMessage(response, "assistant", reply);
        saveState(history, model.value);
      })
      .catch((e: unknown) => {
        history.pop();
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
