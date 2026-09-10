import { sendChat } from "./api.js";
import { renderMessages } from "./render.js";

/**
 * Wires up the chat form: on submit, sends the conversation and appends the
 * model's reply to the thread.
 * @param {HTMLElement} appEl - The app root element.
 */
export function setupChat(appEl) {
  const form = appEl.querySelector("#chat-form");
  const input = appEl.querySelector("#chat-input");
  const button = form.querySelector("button[type=submit]");
  const messagesEl = appEl.querySelector("#chat-messages");

  const sent = []; // conversation sent to the model (user/assistant pairs)
  const display = []; // everything shown in the UI (incl. errors)

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    input.value = "";
    button.disabled = true;

    sent.push({ role: "user", content: message });
    display.push({ role: "user", content: message });
    renderMessages(messagesEl, display);

    try {
      const reply = await sendChat(sent);
      sent.push({ role: "assistant", content: reply });
      display.push({ role: "assistant", content: reply });
    } catch (err) {
      sent.pop(); // undo so the failed turn isn't re-sent
      display.push({ role: "error", content: err.message });
    } finally {
      button.disabled = false;
      renderMessages(messagesEl, display);
    }
  });
}
