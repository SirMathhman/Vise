export function createTranscript(log: HTMLElement) {
  let activeAssistant: HTMLElement | null = null;
  let activeRaw = "";
  let activeThinking: HTMLElement | null = null;

  function addLine(cls: string, text: string): HTMLDivElement {
    const div = document.createElement("div");
    div.className = `line ${cls}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function appendAssistantToken(text: string): void {
    if (!activeAssistant) {
      activeAssistant = document.createElement("div");
      activeAssistant.className = "line assistant";
      log.appendChild(activeAssistant);
      activeRaw = "";
    }
    activeRaw += text;
    activeAssistant.textContent = activeRaw;
    log.scrollTop = log.scrollHeight;
  }

  function appendThinkingToken(text: string): void {
    if (!text) return;
    if (!activeThinking) activeThinking = addLine("thinking", "");
    activeThinking.textContent += text;
    log.scrollTop = log.scrollHeight;
  }

  return {
    addLine,
    appendAssistantToken,
    appendThinkingToken,
    finishThinking(): void {
      activeThinking = null;
    },
    flushAssistant(): void {
      if (activeAssistant) {
        activeAssistant.textContent = activeRaw;
        activeAssistant = null;
        activeRaw = "";
      }
    },
    clear(): void {
      log.textContent = "";
      activeAssistant = null;
      activeRaw = "";
      activeThinking = null;
    },
  };
}
