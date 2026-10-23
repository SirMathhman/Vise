// The Sessions panel: saved conversations, and the autosave after each completed turn.

// Saved sessions in the side panel. The server writes and reads the files; loading replaces the conversation both on
// screen and in the history the next request sends.
const sessionForm = document.getElementById("session-form") as HTMLFormElement;
const sessionName = document.getElementById("session-name") as HTMLInputElement;
const sessionsList = document.getElementById("sessions-list") as HTMLUListElement;
const sessionsStatus = document.getElementById("sessions-status") as HTMLParagraphElement;

// Shows a message in one of the side panel's status lines. An error is shown as an error.
function showStatus(status: HTMLParagraphElement, message: string, isError: boolean): void {
  status.textContent = message;
  status.className = isError ? "error" : "summary";
  status.hidden = false;
}

async function refreshSessions(): Promise<void> {
  try {
    const { sessions } = await postJson<{ sessions: string[] }>("/api/sessions", { action: "list" });
    sessionsList.replaceChildren(
      ...sessions.map((name) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = name;
        button.addEventListener("click", () => {
          void loadSession(name);
        });
        item.append(button);
        return item;
      }),
    );
  } catch (err) {
    showStatus(sessionsStatus,errorMessage(err), true);
  }
}

// Adds one saved message to the log the way the live conversation showed it. Profile instructions are not shown.
function showMessage(message: Message): void {
  if (message.role === "user") {
    addEntry("user").textContent = message.content;
  } else if (message.role === "assistant") {
    const bubble = addEntry("assistant");
    const answer = markdownBlock();
    answer.innerHTML = renderMarkdown(message.content);
    bubble.append(answer);
  } else if (message.role === "summary") {
    addEntry("summary").textContent = "Earlier conversation summarized.";
  } else if (message.role === "summary_failed") {
    addEntry("summary").textContent = "Could not summarize the conversation. It will be tried again later.";
  }
}

sessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = sessionName.value.trim();
  if (name === "") {
    return;
  }
  // A reply in flight is not part of the conversation yet, so the save waits for it.
  if (input.disabled) {
    showStatus(sessionsStatus,"Wait for the reply to finish, then save.", true);
    return;
  }
  try {
    const { message } = await postJson<{ message: string }>("/api/sessions", {
      action: "save",
      name,
      messages: conversation,
      told,
    });
    sessionName.value = "";
    showStatus(sessionsStatus,message, false);
    await refreshSessions();
  } catch (err) {
    showStatus(sessionsStatus,errorMessage(err), true);
  }
});

// The name this conversation autosaves under. It is picked at the first completed turn, and New or Load clears it so
// the next turn starts a new saved session.
let autosaveName: string | null = null;

// Saves the conversation after a completed turn. The save runs in the background: a failure shows in the Sessions
// panel, and the chat is unaffected.
function autosaveTurn(): void {
  autosaveName ??= `auto-${Date.now()}`;
  postJson<{ message: string }>("/api/sessions", {
    action: "save",
    name: autosaveName,
    messages: conversation,
    told,
  }).then(
    () => refreshSessions(),
    (err) => showStatus(sessionsStatus,errorMessage(err), true),
  );
}

async function loadSession(name: string): Promise<void> {
  if (input.disabled) {
    showStatus(sessionsStatus,"Wait for the reply to finish, then load.", true);
    return;
  }
  // Input stays off while the session loads, so a message cannot slip in between the request and the replacement.
  input.disabled = true;
  try {
    const data = await postJson<{ messages: Message[]; told: string[] }>("/api/sessions", { action: "load", name });
    // The default profile must land before the loaded conversation, or it could join the conversation after it.
    await defaultProfile;
    conversation.length = 0;
    conversation.push(...data.messages);
    told = data.told;
    autosaveName = null;
    log.replaceChildren();
    data.messages.forEach(showMessage);
    showStatus(sessionsStatus,`Loaded session ${name}.`, false);
    scrollToEnd();
  } catch (err) {
    showStatus(sessionsStatus,errorMessage(err), true);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

