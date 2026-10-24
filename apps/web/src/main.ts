import "./styles.css";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const root = document.getElementById("root");
if (root) {
  root.innerHTML = `
    <h1>Vise</h1>
    <div id="chat-log"></div>
    <form id="chat-form">
      <input id="message" type="text" placeholder="Send a message..." autocomplete="off" />
      <button type="submit">Send</button>
    </form>
  `;
}

const form = document.getElementById("chat-form") as HTMLFormElement | null;
const input = document.getElementById("message") as HTMLInputElement | null;
const log = document.getElementById("chat-log");

const history: Message[] = [];

function render() {
  if (!log) return;
  log.innerHTML = "";
  for (const msg of history) {
    const div = document.createElement("div");
    div.className = `msg ${msg.role}`;
    div.textContent = msg.content;
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}

if (form && input && log) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    history.push({ role: "user", content: message });
    input.value = "";
    render();

    const pending = document.createElement("div");
    pending.className = "msg assistant pending";
    pending.textContent = "…";
    log.appendChild(pending);
    log.scrollTop = log.scrollHeight;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const data = (await res.json()) as { content?: string };
      const reply = data.content ?? "(empty response)";
      history.push({ role: "assistant", content: reply });
      pending.remove();
      render();
    } catch (err) {
      pending.remove();
      history.push({ role: "assistant", content: `Error: ${err}` });
      render();
    }
  });
}
