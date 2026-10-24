import { Message, ToolUse, sendChat } from "./api";

interface AssistantMessage extends Message {
  tool_calls?: ToolUse[];
}

export class ChatApp {
  private history: AssistantMessage[] = [];
  private log: HTMLElement;
  private input: HTMLInputElement;

  constructor(log: HTMLElement, input: HTMLInputElement) {
    this.log = log;
    this.input = input;
  }

  render(): void {
    this.log.innerHTML = "";
    for (const msg of this.history) {
      const div = document.createElement("div");
      div.className = `msg ${msg.role}`;
      div.textContent = msg.content;
      this.log.appendChild(div);

      if (msg.tool_calls) {
        for (const tool of msg.tool_calls) {
          const block = document.createElement("div");
          block.className = "tool-use";
          block.innerHTML = `
            <div class="tool-use-header">
              <span class="tool-name">${escapeHtml(tool.name)}</span>
              <span class="tool-args">${escapeHtml(JSON.stringify(tool.arguments))}</span>
            </div>
            <pre class="tool-result">${escapeHtml(tool.result)}</pre>
          `;
          this.log.appendChild(block);
        }
      }
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  async submit(): Promise<void> {
    const message = this.input.value.trim();
    if (!message) return;

    this.history.push({ role: "user", content: message });
    this.input.value = "";
    this.render();

    const pending = document.createElement("div");
    pending.className = "msg assistant pending";
    pending.textContent = "…";
    this.log.appendChild(pending);
    this.log.scrollTop = this.log.scrollHeight;

    try {
      const data = await sendChat(this.history);
      const reply = data.content ?? "(empty response)";
      this.history.push({
        role: "assistant",
        content: reply,
        tool_calls: data.tool_calls,
      });
      pending.remove();
      this.render();
    } catch (err) {
      pending.remove();
      this.history.push({ role: "assistant", content: `Error: ${err}` });
      this.render();
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}