import "./styles.css";
import { ChatApp } from "./app";
import { fetchTools } from "./api";
import { escapeHtml } from "./util";

const root = document.getElementById("root");
if (root) {
  root.innerHTML = `
    <h1>Vise</h1>
    <details id="tools-panel">
      <summary>Tools</summary>
      <ul id="tools-list"></ul>
    </details>
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

if (form && input && log) {
  const app = new ChatApp(log, input);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void app.submit();
  });
}

const toolsList = document.getElementById("tools-list");
if (toolsList) {
  void fetchTools()
    .then((tools) => {
      toolsList.innerHTML = tools
        .map(
          (t) =>
            `<li><code>${escapeHtml(t.name)}</code> <span>${escapeHtml(t.description)}</span></li>`,
        )
        .join("");
    })
    .catch(() => {
      toolsList.innerHTML = `<li>Failed to load tools</li>`;
    });
}
