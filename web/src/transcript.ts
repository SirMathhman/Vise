export interface TranscriptView {
  addLine(cls: string, text: string): HTMLDivElement;
  appendAssistantToken(text: string): void;
  appendThinkingToken(text: string): void;
  appendToolCall(name: string, depth?: number): void;
  /** Mark subsequent tool calls as part of a burst (no thinking between). */
  setBurst(active: boolean): void;
  finishThinking(): void;
  flushAssistant(): void;
  clear(): void;
}

export function createTranscript(log: HTMLElement): TranscriptView {
  let burstActive = false;
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

  function flushAssistant(): void {
    if (!activeAssistant) return;
    activeAssistant.textContent = activeRaw;
    activeAssistant = null;
    activeRaw = "";
  }

  function appendAssistantToken(text: string): void {
    activeThinking = null;
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
    flushAssistant();
    if (!activeThinking) activeThinking = addLine("thinking", "");
    activeThinking.textContent += text;
    log.scrollTop = log.scrollHeight;
  }

  return {
    addLine,
    appendAssistantToken,
    appendThinkingToken,
    appendToolCall(name: string, depth?: number): void {
      flushAssistant();
      activeThinking = null;
      const line = addLine("tool", `tool: ${name}${depth ? " (subagent)" : ""}`);
      if (burstActive) line.className += " burst";
    },
    setBurst(active: boolean): void {
      if (active && !burstActive) {
        flushAssistant();
        activeThinking = null;
        addLine("burst", "⚡ burst: running the plan without thinking");
      }
      burstActive = active;
    },
    finishThinking(): void {
      activeThinking = null;
    },
    flushAssistant,
    clear(): void {
      log.textContent = "";
      activeAssistant = null;
      activeRaw = "";
      activeThinking = null;
    },
  };
}
