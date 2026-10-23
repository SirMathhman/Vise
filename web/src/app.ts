// The chat page: wires the chat form, its buttons and the chat tabs to the chats, and starts each panel.

const newButton = document.getElementById("new") as HTMLButtonElement;

// The reply being shown: its chat, its bubble, the reasoning block, and the markdown block the answer streams into.
interface Reply {
  chat: Chat;
  bubble: HTMLDivElement;
  thinking: HTMLDetailsElement;
  thinkingText: HTMLDivElement;
  // Set once the reasoning is over, so the Thinking block folds away only once for each stretch of reasoning.
  reasoningDone: boolean;
  answerText: HTMLDivElement;
  // The reply so far as the model wrote it. It is rendered again as each piece arrives.
  answerRaw: string;
  subagent: Subagent | null;
}

// Adds the assistant's bubble to the chat's log, with its Thinking block hidden until reasoning arrives.
function startReply(chat: Chat): Reply {
  const bubble = addEntry(chat, "assistant");
  const thinking = document.createElement("details");
  thinking.className = "thinking";
  thinking.open = true;
  thinking.hidden = true;
  const thinkingSummary = document.createElement("summary");
  thinkingSummary.textContent = "Thinking";
  const thinkingText = document.createElement("div");
  thinking.append(thinkingSummary, thinkingText);
  const answerText = markdownBlock();
  bubble.append(thinking, answerText);
  return { chat, bubble, thinking, thinkingText, reasoningDone: false, answerText, answerRaw: "", subagent: null };
}

// Folds the Thinking block away once the reasoning is over. It can be opened again from its summary.
function finishReasoning(reply: Reply): void {
  if (!reply.reasoningDone) {
    reply.reasoningDone = true;
    reply.thinking.open = false;
  }
}

// Starts the next step of a workflow: a line that names the step, and a new reply under it. The reply before it is
// removed if nothing was shown in it.
function stepReply(chat: Chat, previous: Reply, text: string): Reply {
  finishReasoning(previous);
  if (previous.bubble.textContent === "") {
    previous.bubble.remove();
  }
  addEntry(chat, "summary").textContent = text;
  return startReply(chat);
}

// Shows one streamed piece of the reply in its place in the bubble.
function showStreamed(reply: Reply, streamed: StreamEvent): void {
  if (streamed.type !== "reasoning") {
    // The answer or a tool call only starts after the reasoning has ended.
    finishReasoning(reply);
  }
  if (streamed.type === "reasoning") {
    if (reply.reasoningDone) {
      // Reasoning after a tool round opens the block again, so it is seen. It folds again when the next round starts.
      reply.reasoningDone = false;
      reply.thinking.open = true;
    }
    reply.thinking.hidden = false;
    reply.thinkingText.textContent += streamed.text;
  } else if (streamed.type === "content") {
    reply.answerRaw += streamed.text;
    reply.answerText.innerHTML = renderMarkdown(reply.answerRaw);
  } else if (streamed.type === "tool") {
    // Text after a tool call goes in a new block below it, so the order matches the stream.
    reply.answerText = markdownBlock();
    reply.answerRaw = "";
    reply.bubble.append(toolLine(streamed.text), reply.answerText);
  } else if (streamed.type === "subagent_start") {
    reply.subagent = openSubagent(reply.bubble, streamed);
  } else if (streamed.type === "nested") {
    if (reply.subagent !== null) {
      renderSubagentStep(reply.subagent, streamed.event);
    }
  } else if (streamed.type === "subagent_end") {
    if (reply.subagent !== null) {
      closeSubagent(reply.subagent, streamed.failed);
    }
    reply.subagent = null;
    // Text after a subagent goes in a new block below it, as text after a tool call does.
    reply.answerText = markdownBlock();
    reply.answerRaw = "";
    reply.bubble.append(reply.answerText);
  }
  scrollToEnd(reply.chat);
}

// Keeps a finished reply. Its profile joins the conversation, and a turn that is not a tool command is kept and saved.
function keepReply(chat: Chat, done: Done, command: boolean): void {
  if (done.profile != null) {
    // A chosen profile's instructions join the conversation, so the later requests keep following them.
    chat.conversation.push({ role: "profile", content: done.profile });
  }
  if (!command) {
    if (done.workflow != null) {
      // A workflow's messages take the place of the command line it was sent as.
      chat.conversation.pop();
      chat.conversation.push(...done.workflow);
    } else {
      // The server may have added a note about switch changes to this user message. The note and the record of switches
      // the model now knows about are kept only once the reply has arrived.
      if (done.user_message != null) {
        chat.conversation[chat.conversation.length - 1].content = done.user_message;
      }
      chat.conversation.push({ role: "assistant", content: done.answer });
    }
    if (done.told) {
      chat.told = done.told;
    }
    // A summary is appended after the reply. The earlier messages stay in the log, unchanged.
    if (done.summary != null) {
      chat.conversation.push({ role: "summary", content: done.summary });
      addEntry(chat, "summary").textContent = "Earlier conversation summarized.";
    } else if (done.summary_failed != null) {
      chat.conversation.push({ role: "summary_failed", content: done.summary_failed });
      addEntry(chat, "summary").textContent = "Could not summarize the conversation. It will be tried again later.";
    }
    autosaveTurn(chat);
  }
}

// A reply that failed or was stopped. Its turn is not kept, and a failure shows its reason.
function failReply(reply: Reply, err: unknown, command: boolean): void {
  const { chat } = reply;
  if (!command) {
    chat.conversation.pop();
  }
  if (chat.inFlight?.signal.aborted) {
    // Stopped by the user: what streamed stays on screen, but the turn is not kept, as a failed one is not.
    addEntry(chat, "summary").textContent =
      "Stopped. Tool calls shown above may already have run, and their effects remain. This turn was not kept in the conversation.";
  } else {
    if (reply.answerText.textContent === "" && reply.thinkingText.textContent === "") {
      reply.bubble.remove();
    }
    addEntry(chat, "error").textContent = errorMessage(err);
  }
}

// Ends a chat's turn, whatever its outcome. The form follows the shown chat, so it is only re-set when that is this one.
function endTurn(chat: Chat): void {
  chat.inFlight = null;
  chat.busy = false;
  refreshForm();
  if (chat === active) {
    input.focus();
  }
  // A typed /enable or /disable changes a switch on the server, so the panel is redrawn from it.
  void refreshTools();
  scrollToEnd(chat);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text === "") {
    return;
  }

  // The turn belongs to the chat shown when it was sent, even if another chat is shown by the time it ends. Sending
  // shows that chat, in case a file was shown in its place.
  const chat = active;
  showChat(chat);
  chat.busy = true;
  refreshForm();
  input.value = "";
  // The default profile must be in place before the user's message joins the conversation.
  await chat.defaultProfile;
  // A chat closed while its profile was loading is not continued, so nothing is sent or saved for it.
  if (chat.closed) {
    endTurn(chat);
    return;
  }
  // Tool commands are answered by the server and kept out of the conversation.
  const command = /^\/(tools|enable|disable|notes|profile)(\s|$)/.test(text);
  if (!command) {
    chat.conversation.push({ role: "user", content: text });
  }
  addEntry(chat, "user").textContent = text;

  let reply = startReply(chat);
  try {
    const messages = command ? [...chat.conversation, { role: "user" as const, content: text }] : chat.conversation;
    const controller = new AbortController();
    chat.inFlight = controller;
    refreshForm();
    const done = await streamChat(
      messages,
      chat.told,
      (streamed) => {
        if (streamed.type === "step") {
          reply = stepReply(chat, reply, streamed.text);
        } else {
          showStreamed(reply, streamed);
        }
      },
      controller.signal,
    );
    finishReasoning(reply);
    keepReply(chat, done, command);
  } catch (err) {
    failReply(reply, err, command);
  } finally {
    endTurn(chat);
  }
});

stopButton.addEventListener("click", () => {
  active.inFlight?.abort();
  active.defaultAbort?.abort();
});

// Opens a new chat with the default profile and shows it. The chats already open are kept.
function newChat(): void {
  const chat = createChat(closeChat);
  showChat(chat);
  void applyDefaultProfile(chat);
}

// Closes a chat. A reply still running in it is stopped. Closing the last chat opens a new one in its place.
function closeChat(chat: Chat): void {
  chat.closed = true;
  chat.inFlight?.abort();
  chat.defaultAbort?.abort();
  const index = chats.indexOf(chat);
  chats.splice(index, 1);
  chat.log.remove();
  chat.tab.remove();
  if (chats.length === 0) {
    newChat();
  } else if (active === chat) {
    showChat(chats[Math.max(0, index - 1)]);
  } else {
    saveChats();
  }
}

// Brings back the chats open at the last visit, with the one that was shown. A chat that was saved comes back from its
// saved session. A chat that cannot be loaded starts empty, and its name is dropped so a reply cannot overwrite the file.
function restoreChats(): void {
  let saved: { names: (string | null)[]; active: number } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(CHATS_KEY) ?? "null");
  } catch {
    // Unreadable or blocked storage: the page starts with one chat.
  }
  if (saved === null || !Array.isArray(saved.names) || saved.names.length === 0) {
    newChat();
    return;
  }
  for (const name of saved.names) {
    const chat = createChat(closeChat);
    if (name === null) {
      void applyDefaultProfile(chat);
    } else {
      chat.autosaveName = name;
      chat.busy = true;
      void loadInto(chat, name).then(
        () => {
          chat.busy = false;
          refreshForm();
        },
        (err) => {
          chat.autosaveName = null;
          chat.busy = false;
          addEntry(chat, "error").textContent = errorMessage(err);
          refreshForm();
        },
      );
    }
  }
  showChat(chats[saved.active] ?? chats[0]);
}

newButton.addEventListener("click", newChat);
restoreChats();
restoreFiles();
void refreshTools();
void refreshNotes();
void refreshSessions();
void refreshFiles();

// A narrower window clamps the shown width without changing the chosen one, and nothing is saved here.
window.addEventListener("resize", applyPanelWidths);
