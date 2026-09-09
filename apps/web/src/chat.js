/**
 * Sends a single message to the LLM via the backend and returns the reply.
 * @param {string} message - The user's message.
 * @returns {Promise<string>} The model's reply.
 */
export async function sendChat(message) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed: ${res.status}`);
  return data.reply;
}

/**
 * Wires up the chat form: on submit, sends the message and shows the reply.
 * @param {HTMLElement} appEl - The app root element.
 */
export function setupChat(appEl) {
  const form = appEl.querySelector("#chat-form");
  const input = appEl.querySelector("#chat-input");
  const button = form.querySelector("button[type=submit]");
  const codeEl = appEl.querySelector("#chat-response code");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    button.disabled = true;
    codeEl.textContent = "Thinking…";

    try {
      codeEl.textContent = await sendChat(message);
    } catch (err) {
      codeEl.textContent = `Could not get a reply: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  });
}
