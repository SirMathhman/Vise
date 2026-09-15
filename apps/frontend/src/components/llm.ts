import {
  type LlmMessage,
  listLlmModels,
  sendLlmMessage,
} from "../api/client.js";

/**
 * Wire up the LLM panel. Loads the model list into the selector and connects
 * the Send button (and Ctrl/Cmd+Enter) to a chat completion that renders the
 * full conversation into the response list. Clear resets the history.
 */
export function setupLlm(root: HTMLElement): void {
  const model = root.querySelector<HTMLSelectElement>("#llm-model");
  const prompt = root.querySelector<HTMLTextAreaElement>("#llm-prompt");
  const response = root.querySelector<HTMLElement>("#llm-response");
  const send = root.querySelector<HTMLButtonElement>("#llm-send");
  const clear = root.querySelector<HTMLButtonElement>("#llm-clear");
  if (!model || !prompt || !response || !send) return;

  const history: LlmMessage[] = [];

  listLlmModels()
    .then((models) => {
      if (models.length === 0) {
        setLlmHint(response, "No models served.");
        return;
      }
      model.innerHTML = models
        .map((m) => `<option value="${m.id}">${m.id}</option>`)
        .join("");
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
    send.disabled = true;
    setLlmHint(response, "Thinking…");
    sendLlmMessage(history, m)
      .then((reply) => {
        history.push({ role: "assistant", content: reply });
        removeHint(response);
        renderMessage(response, "assistant", reply);
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
  };

  send.addEventListener("click", submit);
  clear?.addEventListener("click", doClear);
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
