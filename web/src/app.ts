type Role = "user" | "assistant";

interface Message {
  role: Role;
  content: string;
}

type StreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

const conversation: Message[] = [];

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
): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok || res.body === null) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  for (;;) {
    const { done, value } = await reader.read();
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
        return answer;
      }
      if (event.type === "content") {
        answer += event.text;
      }
      onEvent(event);
    }
  }
  return answer;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text === "") {
    return;
  }

  input.value = "";
  conversation.push({ role: "user", content: text });
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
  const answerText = document.createElement("div");
  bubble.append(thinking, answerText);

  try {
    const reply = await streamChat(conversation, (streamed) => {
      if (streamed.type === "reasoning") {
        thinking.hidden = false;
        thinkingText.textContent += streamed.text;
      } else if (streamed.type === "content") {
        answerText.textContent += streamed.text;
      }
      scrollToEnd();
    });
    conversation.push({ role: "assistant", content: reply });
  } catch (err) {
    conversation.pop();
    addEntry("error").textContent = err instanceof Error ? err.message : String(err);
  } finally {
    input.disabled = false;
    input.focus();
    scrollToEnd();
  }
});

newButton.addEventListener("click", () => {
  conversation.length = 0;
  log.replaceChildren();
});
