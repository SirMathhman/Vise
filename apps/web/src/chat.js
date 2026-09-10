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
  const followBtn = appEl.querySelector("#chat-follow");

  const sent = []; // conversation sent to the model (user/assistant pairs)
  const display = []; // everything shown in the UI (incl. errors)

  let follow = true; // pin the view to the latest message
  let prevScrollTop = 0; // restore scroll when follow is off

  const isAtBottom = () =>
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
    8;

  const setFollow = (value) => {
    follow = value;
    followBtn.setAttribute("aria-pressed", String(value));
  };

  followBtn.addEventListener("click", () => {
    setFollow(!follow);
    if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  // Scrolling up away from the bottom turns follow off; reaching the bottom
  // turns it back on.
  messagesEl.addEventListener("scroll", () => {
    if (isAtBottom()) setFollow(true);
    else setFollow(false);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    input.value = "";
    button.disabled = true;
    prevScrollTop = messagesEl.scrollTop;

    sent.push({ role: "user", content: message });
    display.push({ role: "user", content: message });
    display.push({ role: "assistant", content: "" }); // placeholder, filled as it streams
    renderMessages(messagesEl, display);
    if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;

    // Reference the streaming message's content element so we can update it
    // in place as deltas arrive, without rebuilding the whole list.
    const streamingEl =
      messagesEl.lastElementChild?.querySelector(".chat-msg-content") ?? null;

    try {
      const { reply, toolCalls } = await sendChat(sent, (delta) => {
        const last = display[display.length - 1];
        last.content += delta;
        if (streamingEl) streamingEl.textContent = last.content;
        if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
      });
      sent.push({ role: "assistant", content: reply });
      const last = display[display.length - 1];
      last.content = reply;
      last.toolCalls = toolCalls;
    } catch (err) {
      sent.pop(); // undo so the failed turn isn't re-sent
      display.pop(); // drop the placeholder
      display.push({ role: "error", content: err.message });
    } finally {
      button.disabled = false;
      renderMessages(messagesEl, display);
      if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
      else messagesEl.scrollTop = prevScrollTop;
    }
  });
}
