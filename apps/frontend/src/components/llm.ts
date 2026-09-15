import { listLlmModels, sendLlmMessage } from "../api/client.js";

/**
 * Wire up the LLM panel. Loads the model list into the selector and connects
 * the Send button (and Ctrl/Cmd+Enter) to a single non-streamed chat
 * completion whose reply renders into the response area.
 */
export function setupLlm(root: HTMLElement): void {
  const model = root.querySelector<HTMLSelectElement>("#llm-model");
  const prompt = root.querySelector<HTMLTextAreaElement>("#llm-prompt");
  const response = root.querySelector<HTMLElement>("#llm-response");
  const send = root.querySelector<HTMLButtonElement>("#llm-send");
  if (!model || !prompt || !response || !send) return;

  listLlmModels()
    .then((models) => {
      if (models.length === 0) {
        setLlmHint(response, "No models served.", "llm-hint");
        return;
      }
      model.innerHTML = models
        .map((m) => `<option value="${m.id}">${m.id}</option>`)
        .join("");
    })
    .catch((e: unknown) =>
      setLlmHint(
        response,
        `Failed to load models: ${e instanceof Error ? e.message : e}`,
        "llm-error"
      )
    );

  const submit = () => {
    const text = prompt.value.trim();
    const m = model.value;
    if (!text || !m) return;
    send.disabled = true;
    setLlmHint(response, "Thinking…", "llm-loading");
    sendLlmMessage(text, m)
      .then((reply) => {
        response.textContent = reply;
      })
      .catch((e: unknown) =>
        setLlmHint(
          response,
          `Request failed: ${e instanceof Error ? e.message : e}`,
          "llm-error"
        )
      )
      .finally(() => {
        send.disabled = false;
      });
  };

  send.addEventListener("click", submit);
  prompt.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
  });
}

function setLlmHint(response: HTMLElement, text: string, cls: string): void {
  response.innerHTML = "";
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text;
  response.append(span);
}
