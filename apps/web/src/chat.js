import { fetchNotesSnapshot, sendChat } from "./api.js";
import {
  addConversation,
  conversations,
  deleteConversation,
  getCurrentIndex,
  load,
  saveActive,
  setActiveIndex,
  titleFor,
} from "./conversations.js";
import { renderMessages } from "./render.js";
import { getOpenFilePath } from "./state.js";
import { setupKeyboardMenu } from "./menu.js";

/**
 * Wires up the chat form: on submit, sends the conversation and appends the
 * model's reply to the thread. Also manages multiple conversations via a
 * dropdown in the chat header — the user can switch between them, and Clear
 * starts a new one.
 * @param {HTMLElement} appEl - The app root element.
 */
export function setupChat(appEl) {
  const form = appEl.querySelector("#chat-form");
  const input = appEl.querySelector("#chat-input");
  const button = form.querySelector("button[type=submit]");
  const messagesEl = appEl.querySelector("#chat-messages");
  const followBtn = appEl.querySelector("#chat-follow");
  const clearBtn = appEl.querySelector("#chat-clear");
  const convoBtn = appEl.querySelector("#chat-convo-btn");
  const convoList = appEl.querySelector("#chat-convo-list");

  const sent = []; // conversation sent to the model (user/assistant pairs)
  const display = []; // everything shown in the UI (incl. errors)

  let follow = true; // pin the view to the latest message
  let prevScrollTop = 0; // restore scroll when follow is off
  let generation = 0; // bumped on clear so a stale stream can't touch state
  let conversationId = crypto.randomUUID();
  let notesSnapshot = "";

  // The active conversation's live working set (sent/display/notesSnapshot)
  // lives here in chat.js; the full list of conversations, which one is
  // active, and the persistence/migration logic live in conversations.js.
  // After any change to the live state we call saveActive to sync it into the
  // active slot and serialize to localStorage.
  const save = () =>
    saveActive({ id: conversationId, sent, display, notesSnapshot });

  const restore = (conv) => {
    conversationId = conv.id;
    sent.length = 0;
    sent.push(...conv.sent);
    display.length = 0;
    display.push(...conv.display);
    notesSnapshot = conv.notesSnapshot ?? "";
    setFollow(true);
    renderMessages(messagesEl, display);
  };

  const newConversation = () => {
    generation++;
    conversationId = crypto.randomUUID();
    notesSnapshot = "";
    sent.length = 0;
    display.length = 0;
    setFollow(true);
    renderMessages(messagesEl, display);
    // Append a fresh entry so Clear genuinely starts a new conversation the
    // user can switch back to later (and so the live state has a home).
    addConversation(conversationId);
    save();
    updateConvoBtn();
  };

  const updateConvoBtn = () => {
    const span = convoBtn.querySelector(".chat-convo-title");
    if (span) span.textContent = titleFor(conversations[getCurrentIndex()]);
  };

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
    newConversation();
  });

  // Initialize: load() reads and migrates the persisted conversation list and
  // sets the active index, returning the active conversation, or null when
  // there is nothing to restore — in which case start a fresh conversation.
  const active = load();
  if (active) {
    restore(active);
  } else {
    addConversation(conversationId);
  }

  // Dropdown: click the button to open/close; click a conversation to switch.
  const toggleDropdown = () => {
    const hidden = convoList.hidden;
    if (hidden) {
      // Populate the list with all conversations.
      for (let i = 0; i < conversations.length; i++) {
        const li = document.createElement("li");
        li.dataset.index = String(i);
        li.setAttribute("role", "menuitem");
        li.setAttribute("tabindex", "-1");
        const title = document.createElement("span");
        title.className = "chat-convo-item-title";
        title.textContent = titleFor(conversations[i]);
        const del = document.createElement("button");
        del.className = "chat-convo-delete";
        del.type = "button";
        del.textContent = "\u00d7";
        del.setAttribute("aria-label", "Delete conversation");
        li.append(title, del);
        if (i === getCurrentIndex()) li.classList.add("chat-convo-active");
        convoList.appendChild(li);
      }
      convoList.hidden = false;
      convoBtn.setAttribute("aria-expanded", "true");
      convoMenu.open();
    } else {
      closeDropdown();
    }
  };

  const closeDropdown = () => {
    convoList.replaceChildren();
    convoList.hidden = true;
    convoBtn.setAttribute("aria-expanded", "false");
  };

  const convoMenu = setupKeyboardMenu({
    listEl: convoList,
    activate: (li) => {
      const idx = Number(li.dataset.index);
      if (Number.isInteger(idx) && idx >= 0 && idx < conversations.length) {
        generation++;
        setActiveIndex(idx);
        restore(conversations[idx]);
        save();
        closeDropdown();
        updateConvoBtn();
        convoBtn.focus();
      }
    },
  });

  convoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDropdown();
  });

  convoList.addEventListener("click", (e) => {
    // Delete: remove the conversation and restore the new active one
    // (or start a fresh conversation if none remain).
    if (e.target.closest(".chat-convo-delete")) {
      const li = e.target.closest("li");
      const idx = Number(li.dataset.index);
      deleteConversation(idx);
      closeDropdown();
      if (conversations.length === 0) {
        newConversation();
      } else {
        generation++;
        restore(conversations[getCurrentIndex()]);
        save();
        updateConvoBtn();
      }
      return;
    }
    const li = e.target.closest("li");
    if (!li || !convoList.contains(li)) return;
    const idx = Number(li.dataset.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < conversations.length) {
      generation++;
      setActiveIndex(idx);
      restore(conversations[idx]);
      save();
      closeDropdown();
      updateConvoBtn();
    }
  });

  // Close the dropdown on outside click or Escape.
  document.addEventListener("click", (e) => {
    if (convoList.hidden) return;
    if (e.target.closest(".chat-convo-dropdown")) return;
    closeDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !convoList.hidden) {
      closeDropdown();
      convoBtn.focus();
    }
  });

  updateConvoBtn();

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

    // Fetch the notes snapshot lazily on the first send of a new
    // conversation. On restore, notesSnapshot is already set from
    // localStorage, so this is skipped.
    if (!notesSnapshot) {
      try {
        notesSnapshot = await fetchNotesSnapshot();
      } catch {
        // If the snapshot fetch fails, send an empty snapshot — the backend
        // will build a fresh one, which is the existing behavior.
        notesSnapshot = "";
      }
    }

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
        conversationId,
        notesSnapshot,
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
      save();
      if (generation === gen) {
        renderMessages(messagesEl, display);
        updateConvoBtn();
        if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
        else messagesEl.scrollTop = prevScrollTop;
      }
    }
  });
}
