// The Sessions panel: saved conversations, and the autosave after each completed turn of each open chat.

// Saved sessions in the side panel. The server writes and reads the files; loading replaces the shown chat's conversation
// both on screen and in the history the next request sends.
const sessionForm = document.getElementById("session-form") as HTMLFormElement;
const sessionName = document.getElementById("session-name") as HTMLInputElement;
const sessionsList = document.getElementById("sessions-list") as HTMLUListElement;
const sessionsStatus = document.getElementById("sessions-status") as HTMLParagraphElement;

async function refreshSessions(): Promise<void> {
  try {
    const { sessions } = await postJson<{ sessions: { name: string; title: string | null }[] }>("/api/sessions", {
      action: "list",
    });
    sessionsList.replaceChildren(
      ...sessions.map(({ name, title }) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        // A session without a title shows its name.
        button.textContent = title ?? name;
        button.addEventListener("click", () => {
          void loadSession(name);
        });
        item.append(button);
        return item;
      }),
    );
  } catch (err) {
    showStatus(sessionsStatus, errorMessage(err), true);
  }
}

// Adds one saved message to a chat's log the way the live conversation showed it. Profile instructions are not shown.
function showMessage(chat: Chat, message: Message): void {
  if (message.role === "user") {
    addEntry(chat, "user").textContent = message.content;
  } else if (message.role === "assistant") {
    const bubble = addEntry(chat, "assistant");
    const answer = markdownBlock();
    answer.innerHTML = renderMarkdown(message.content);
    bubble.append(answer);
  } else if (message.role === "summary") {
    addEntry(chat, "summary").textContent = "Earlier conversation summarized.";
  } else if (message.role === "summary_failed") {
    addEntry(chat, "summary").textContent = "Could not summarize the conversation. It will be tried again later.";
  }
}

sessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = sessionName.value.trim();
  if (name === "") {
    return;
  }
  const chat = active;
  // A reply in flight is not part of the conversation yet, so the save waits for it.
  if (chat.busy) {
    showStatus(sessionsStatus, "Wait for the reply to finish, then save.", true);
    return;
  }
  try {
    const { message } = await postJson<{ message: string }>("/api/sessions", {
      action: "save",
      name,
      messages: chat.conversation,
      told: chat.told,
    });
    sessionName.value = "";
    showStatus(sessionsStatus, message, false);
    await refreshSessions();
  } catch (err) {
    showStatus(sessionsStatus, errorMessage(err), true);
  }
});

// Saves a chat's conversation after a completed turn. The save runs in the background: a failure shows in the Sessions
// panel, and the chat is unaffected. The chat's name is picked at its first save, so later turns update the same session.
// After the first turn, the session is also given a title, asked of the model from that first exchange.
function autosaveTurn(chat: Chat): void {
  if (chat.autosaveName === null) {
    chat.autosaveName = `auto-${Date.now()}`;
    saveChats();
  }
  const name = chat.autosaveName;
  const firstTurn = chat.conversation.filter((message) => message.role === "user").length === 1;
  const exchange = chat.conversation.filter((message) => message.role === "user" || message.role === "assistant").slice(0, 2);
  // The save and the title are for this chat's folder, even when another chat is the one shown by now.
  postJson<{ message: string }>("/api/sessions", {
    action: "save",
    name,
    messages: chat.conversation,
    told: chat.told,
    working_dir: chat.workingDir,
  })
    .then(async () => {
      if (firstTurn) {
        await postJson<{ title: string }>("/api/sessions", {
          action: "title",
          name,
          messages: exchange,
          working_dir: chat.workingDir,
        });
      }
    })
    .then(
      () => refreshSessions(),
      (err) => showStatus(sessionsStatus, errorMessage(err), true),
    );
}

// Fills a chat from a saved session: its conversation and switches are replaced, and its log shows the saved messages.
async function loadInto(chat: Chat, name: string): Promise<void> {
  const data = await postJson<{ messages: Message[]; told: string[] }>("/api/sessions", {
    action: "load",
    name,
    working_dir: chat.workingDir,
  });
  // The default profile must land before the loaded conversation, or it could join the conversation after it.
  await chat.defaultProfile;
  chat.conversation.length = 0;
  chat.conversation.push(...data.messages);
  chat.told = data.told;
  chat.log.replaceChildren();
  data.messages.forEach((message) => showMessage(chat, message));
  scrollToEnd(chat);
}

// Loads a saved session into the shown chat. The next turn starts a new saved session, as it did before chats were tabs.
async function loadSession(name: string): Promise<void> {
  const chat = active;
  showChat(chat);
  if (chat.busy) {
    showStatus(sessionsStatus, "Wait for the reply to finish, then load.", true);
    return;
  }
  // Input stays off while the session loads, so a message cannot slip in between the request and the replacement.
  chat.busy = true;
  refreshForm();
  try {
    await loadInto(chat, name);
    chat.autosaveName = null;
    saveChats();
    showStatus(sessionsStatus, `Loaded session ${name}.`, false);
  } catch (err) {
    showStatus(sessionsStatus, errorMessage(err), true);
  } finally {
    chat.busy = false;
    refreshForm();
    input.focus();
  }
}
