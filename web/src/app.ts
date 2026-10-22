type Role = "user" | "assistant" | "summary" | "summary_failed";

interface Message {
  role: Role;
  content: string;
}

type StreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "tool"; text: string }
  | { type: "done"; answer: string; user_message?: string | null; told?: string[]; summary?: string | null; summary_failed?: string | null }
  | { type: "error"; error: string };

type Done = Extract<StreamEvent, { type: "done" }>;

const conversation: Message[] = [];
// The switched-off tools the model has been told about in this conversation.
let told: string[] = [];

const log = document.getElementById("log") as HTMLDivElement;
const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("input") as HTMLInputElement;
const newButton = document.getElementById("new") as HTMLButtonElement;

function addEntry(kind: Role | "error"): HTMLDivElement {
  const entry = document.createElement("div");
  entry.className = kind;
  log.appendChild(entry);
  return entry;
}

function scrollToEnd(): void {
  log.scrollTop = log.scrollHeight;
}

async function streamChat(
  messages: Message[],
  onEvent: (event: StreamEvent) => void,
): Promise<Done> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, told }),
    });
  } catch {
    throw new Error(
      `Could not reach the Vise server at ${location.origin}. Check that "vise web" is still running, then try again.`,
    );
  }
  if (!res.ok || res.body === null) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read().catch(() => {
      throw new Error("The connection dropped partway through the reply. Try again.");
    });
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");

      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (line === undefined) {
        continue;
      }
      const event = JSON.parse(line.slice("data: ".length)) as StreamEvent;
      if (event.type === "error") {
        throw new Error(event.error);
      }
      if (event.type === "done") {
        return event;
      }
      onEvent(event);
    }
  }
  throw new Error("The reply ended before it finished. Try again.");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text === "") {
    return;
  }

  input.value = "";
  // Tool commands are answered by the server and kept out of the conversation.
  const command = /^\/(tools|enable|disable)(\s|$)/.test(text);
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
  let answerText = document.createElement("div");
  bubble.append(thinking, answerText);

  try {
    const messages = command ? [...conversation, { role: "user" as const, content: text }] : conversation;
    const done = await streamChat(messages, (streamed) => {
      if (streamed.type === "reasoning") {
        thinking.hidden = false;
        thinkingText.textContent += streamed.text;
      } else if (streamed.type === "content") {
        answerText.textContent += streamed.text;
      } else if (streamed.type === "tool") {
        // Text after a tool call goes in a new block below it, so the order matches the stream.
        const toolLine = document.createElement("div");
        toolLine.className = "tool";
        toolLine.textContent = `[tool] ${streamed.text}`;
        answerText = document.createElement("div");
        bubble.append(toolLine, answerText);
      }
      scrollToEnd();
    });
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
    }
  } catch (err) {
    if (!command) {
      conversation.pop();
    }
    if (answerText.textContent === "" && thinkingText.textContent === "") {
      bubble.remove();
    }
    addEntry("error").textContent = err instanceof Error ? err.message : String(err);
  } finally {
    input.disabled = false;
    input.focus();
    scrollToEnd();
  }
});

newButton.addEventListener("click", () => {
  conversation.length = 0;
  told = [];
  log.replaceChildren();
});
