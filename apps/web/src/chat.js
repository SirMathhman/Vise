import { sendChat } from "./api.js";
import { renderMessages } from "./render.js";
import { getOpenFilePath } from "./state.js";

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
  const clearBtn = appEl.querySelector("#chat-clear");

  const sent = []; // conversation sent to the model (user/assistant pairs)
  const display = []; // everything shown in the UI (incl. errors)

  let follow = true; // pin the view to the latest message
  let prevScrollTop = 0; // restore scroll when follow is off
  let generation = 0; // bumped on clear so a stale stream can't touch state

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

  clearBtn.addEventListener("click", () => {
    generation++;
    sent.length = 0;
    display.length = 0;
    setFollow(true);
    renderMessages(messagesEl, display);
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

    // Append context about the currently open file so the model can answer
    // questions like "what file do I have open?". Kept out of the displayed
    // message so the user's bubble shows only what they typed.
    const openPath = getOpenFilePath();
    const context = openPath
      ? `\n\n[Context: the file currently open in the viewer is "${openPath}".]`
      : "\n\n[Context: no file is currently open in the viewer.]";

    sent.push({ role: "user", content: message + context });
    display.push({ role: "user", content: message });
    display.push({
      role: "assistant",
      content: "",
      reasoning: "",
    }); // placeholder, filled as it streams
    renderMessages(messagesEl, display);
    if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;

    // Reference the streaming message's elements so we can update them in
    // place as deltas arrive, without rebuilding the whole list.
    let streamingEl =
      messagesEl.lastElementChild?.querySelector(".chat-msg-content") ?? null;
    let reasoningEl =
      messagesEl.lastElementChild?.querySelector(".chat-msg-reasoning") ?? null;

    // Re-fetch the element references after a re-render (the DOM is rebuilt).
    const refreshRefs = () => {
      const lastEl = messagesEl.lastElementChild;
      streamingEl = lastEl?.querySelector(".chat-msg-content") ?? null;
      reasoningEl = lastEl?.querySelector(".chat-msg-reasoning") ?? null;
    };

    // If the user clears while this turn is streaming, the stale stream's
    // callbacks must not touch sent/display (they'd be empty). The captured
    // generation is compared against the live counter on every mutation.
    const gen = generation;

    try {
      const { reply, reasoning, toolCalls } = await sendChat(
        sent,
        (delta) => {
          if (generation !== gen) return;
          const last = display[display.length - 1];
          last.content += delta;
          if (streamingEl) streamingEl.textContent = last.content;
          if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
        },
        (delta) => {
          if (generation !== gen) return;
          const last = display[display.length - 1];
          last.reasoning += delta;
          if (!reasoningEl) {
            // First reasoning chunk: the reasoning block doesn't exist yet
            // (renderMessages only creates it once reasoning is non-empty),
            // so re-render to create it and refresh the element references.
            renderMessages(messagesEl, display);
            refreshRefs();
          }
          if (reasoningEl) {
            const contentEl = reasoningEl.querySelector(
              ".chat-msg-reasoning-content",
            );
            if (contentEl) contentEl.textContent = last.reasoning;
          }
          if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
        },
        (file) => {
          // The model wrote a file; let the file viewer animate it in if it's
          // the file currently open.
          appEl.dispatchEvent(new CustomEvent("file-edit", { detail: file }));
        },
      );
      if (generation === gen) {
        sent.push({ role: "assistant", content: reply });
        const last = display[display.length - 1];
        last.content = reply;
        last.reasoning = reasoning;
        last.toolCalls = toolCalls;
      }
    } catch (err) {
      if (generation === gen) {
        sent.pop(); // undo so the failed turn isn't re-sent
        display.pop(); // drop the placeholder
        display.push({ role: "error", content: err.message });
      }
    } finally {
      button.disabled = false;
      if (generation === gen) {
        renderMessages(messagesEl, display);
        if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
        else messagesEl.scrollTop = prevScrollTop;
      }
    }
  });
}
