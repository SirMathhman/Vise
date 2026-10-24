import { Message, sendChat } from "./api";

export class ChatApp {
  private history: Message[] = [];
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
      this.history.push({ role: "assistant", content: reply });
      pending.remove();
      this.render();
    } catch (err) {
      pending.remove();
      this.history.push({ role: "assistant", content: `Error: ${err}` });
      this.render();
    }
  }
}
