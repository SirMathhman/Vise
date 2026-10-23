// The chat page: wires the chat form and its buttons to the chat, and starts each panel.

const newButton = document.getElementById("new") as HTMLButtonElement;
const stopButton = document.getElementById("stop") as HTMLButtonElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;
// The request in flight, if any: Stop aborts it. Aborting closes the connection, and the server stops the turn.
let inFlight: AbortController | null = null;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text === "") {
    return;
  }

  // The default profile must be in place before the user's message joins the conversation.
  input.disabled = true;
  await defaultProfile;
  input.value = "";
  // Tool commands are answered by the server and kept out of the conversation.
  const command = /^\/(tools|enable|disable|notes|profile)(\s|$)/.test(text);
  if (!command) {
    conversation.push({ role: "user", content: text });
  }
  addEntry("user").textContent = text;
  input.disabled = true;

  const bubble = addEntry("assistant");
  const thinking = document.createElement("details");
  thinking.className = "thinking";
  thinking.open = true;
  thinking.hidden = true;
  const thinkingSummary = document.createElement("summary");
  thinkingSummary.textContent = "Thinking";
  const thinkingText = document.createElement("div");
  thinking.append(thinkingSummary, thinkingText);
  let answerText = markdownBlock();
  // The reply so far as the model wrote it. It is rendered again as each piece arrives.
  let answerRaw = "";
  bubble.append(thinking, answerText);

  try {
    const messages = command ? [...conversation, { role: "user" as const, content: text }] : conversation;
    const controller = new AbortController();
    inFlight = controller;
    sendButton.hidden = true;
    stopButton.hidden = false;
    let subagent: Subagent | null = null;
    const done = await streamChat(messages, (streamed) => {
      if (streamed.type === "reasoning") {
        thinking.hidden = false;
        thinkingText.textContent += streamed.text;
      } else if (streamed.type === "content") {
        answerRaw += streamed.text;
        answerText.innerHTML = renderMarkdown(answerRaw);
      } else if (streamed.type === "tool") {
        // Text after a tool call goes in a new block below it, so the order matches the stream.
        answerText = markdownBlock();
        answerRaw = "";
        bubble.append(toolLine(streamed.text), answerText);
      } else if (streamed.type === "subagent_start") {
        subagent = openSubagent(bubble, streamed);
      } else if (streamed.type === "nested") {
        if (subagent !== null) {
          renderSubagentStep(subagent, streamed.event);
        }
      } else if (streamed.type === "subagent_end") {
        if (subagent !== null) {
          closeSubagent(subagent, streamed.failed);
        }
        subagent = null;
        // Text after a subagent goes in a new block below it, as text after a tool call does.
        answerText = markdownBlock();
        answerRaw = "";
        bubble.append(answerText);
      }
      scrollToEnd();
    }, controller.signal);
    if (done.profile != null) {
      // A chosen profile's instructions join the conversation, so the later requests keep following them.
      conversation.push({ role: "profile", content: done.profile });
    }
    if (!command) {
      // The server may have added a note about switch changes to this user message, and returns the
      // record of switches the model now knows about. Both are kept only once the reply has arrived.
      if (done.user_message != null) {
        conversation[conversation.length - 1].content = done.user_message;
      }
      if (done.told) {
        told = done.told;
      }
      conversation.push({ role: "assistant", content: done.answer });
      // A summary is appended after the reply. The earlier messages stay in the log, unchanged.
      if (done.summary != null) {
        conversation.push({ role: "summary", content: done.summary });
        addEntry("summary").textContent = "Earlier conversation summarized.";
      } else if (done.summary_failed != null) {
        conversation.push({ role: "summary_failed", content: done.summary_failed });
        addEntry("summary").textContent = "Could not summarize the conversation. It will be tried again later.";
      }
      autosaveTurn();
    }
  } catch (err) {
    if (!command) {
      conversation.pop();
    }
    if (inFlight?.signal.aborted) {
      // Stopped by the user: what streamed stays on screen, but the turn is not kept, as a failed one is not.
      addEntry("summary").textContent =
        "Stopped. Tool calls shown above may already have run, and their effects remain. This turn was not kept in the conversation.";
    } else {
      if (answerText.textContent === "" && thinkingText.textContent === "") {
        bubble.remove();
      }
      addEntry("error").textContent = errorMessage(err);
    }
  } finally {
    inFlight = null;
    sendButton.hidden = false;
    stopButton.hidden = true;
    input.disabled = false;
    input.focus();
    // A typed /enable or /disable changes a switch on the server, so the panel is redrawn from it.
    void refreshTools();
    scrollToEnd();
  }
});

stopButton.addEventListener("click", () => {
  inFlight?.abort();
  defaultAbort?.abort();
});

newButton.addEventListener("click", () => {
  conversation.length = 0;
  told = [];
  autosaveName = null;
  log.replaceChildren();
  void applyDefaultProfile();
});
void refreshTools();
void refreshNotes();
void refreshSessions();
void refreshFiles();
void applyDefaultProfile();

// A narrower window clamps the shown width without changing the chosen one, and nothing is saved here.
window.addEventListener("resize", applyPanelWidths);
