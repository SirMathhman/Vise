// The chat page: wires the chat form and its buttons to the chat, and starts each panel.

const newButton = document.getElementById("new") as HTMLButtonElement;
const stopButton = document.getElementById("stop") as HTMLButtonElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;
// The request in flight, if any: Stop aborts it. Aborting closes the connection, and the server stops the turn.
let inFlight: AbortController | null = null;
// The reply being shown: its bubble, the reasoning block, and the markdown block the answer streams into.
interface Reply {
  bubble: HTMLDivElement;
  thinking: HTMLDetailsElement;
  thinkingText: HTMLDivElement;
  answerText: HTMLDivElement;
  // The reply so far as the model wrote it. It is rendered again as each piece arrives.
  answerRaw: string;
  subagent: Subagent | null;
}

// Adds the assistant's bubble to the log, with its Thinking block hidden until reasoning arrives.
function startReply(): Reply {
  const bubble = addEntry("assistant");
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
  return { bubble, thinking, thinkingText, answerText, answerRaw: "", subagent: null };
}

// Shows one streamed piece of the reply in its place in the bubble.
function showStreamed(reply: Reply, streamed: StreamEvent): void {
  if (streamed.type === "reasoning") {
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
  scrollToEnd();
}

// Keeps a finished reply. Its profile joins the conversation, and a turn that is not a tool command is kept and saved.
function keepReply(done: Done, command: boolean): void {
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
}

// A reply that failed or was stopped. Its turn is not kept, and a failure shows its reason.
function failReply(reply: Reply, err: unknown, command: boolean): void {
  if (!command) {
    conversation.pop();
  }
  if (inFlight?.signal.aborted) {
    // Stopped by the user: what streamed stays on screen, but the turn is not kept, as a failed one is not.
    addEntry("summary").textContent =
      "Stopped. Tool calls shown above may already have run, and their effects remain. This turn was not kept in the conversation.";
  } else {
    if (reply.answerText.textContent === "" && reply.thinkingText.textContent === "") {
      reply.bubble.remove();
    }
    addEntry("error").textContent = errorMessage(err);
  }
}

// Puts the form back once a reply has ended, whatever its outcome.
function endTurn(): void {
  inFlight = null;
  sendButton.hidden = false;
  stopButton.hidden = true;
  input.disabled = false;
  input.focus();
  // A typed /enable or /disable changes a switch on the server, so the panel is redrawn from it.
  void refreshTools();
  scrollToEnd();
}

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

  const reply = startReply();
  try {
    const messages = command ? [...conversation, { role: "user" as const, content: text }] : conversation;
    const controller = new AbortController();
    inFlight = controller;
    sendButton.hidden = true;
    stopButton.hidden = false;
    const done = await streamChat(messages, (streamed) => showStreamed(reply, streamed), controller.signal);
    keepReply(done, command);
  } catch (err) {
    failReply(reply, err, command);
  } finally {
    endTurn();
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
