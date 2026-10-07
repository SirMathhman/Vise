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

/**
 * `renderHtml`, when given, turns assistant markdown into sanitized HTML; when
 * omitted, assistant text is shown verbatim.
 */
export function createTranscript(
  log: HTMLElement,
  renderHtml?: (markdown: string) => string,
): TranscriptView {
  let burstActive = false;
  let activeAssistant: HTMLElement | null = null;
  let activeRaw = "";
  let activeThinking: HTMLElement | null = null;

  // Thinking lines start collapsed and collapse again when the thinking ends.
  function endThinking(): void {
    if (activeThinking) {
      activeThinking.className = activeThinking.className.replace(/ open$/, "");
    }
    activeThinking = null;
  }

  // Click a thinking line to open or close it.
  log.addEventListener?.("click", (event) => {
    const line = (event.target as HTMLElement | null)?.closest?.(
      ".line.thinking",
    );
    if (!(line instanceof HTMLElement)) return;
    line.className = line.className.endsWith(" open")
      ? line.className.replace(/ open$/, "")
      : `${line.className} open`;
  });

  function addLine(cls: string, text: string): HTMLDivElement {
    const div = document.createElement("div");
    div.className = `line ${cls}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function showAssistant(element: HTMLElement, raw: string): void {
    if (renderHtml) element.innerHTML = renderHtml(raw);
    else element.textContent = raw;
  }

  function flushAssistant(): void {
    if (!activeAssistant) return;
    showAssistant(activeAssistant, activeRaw);
    activeAssistant = null;
    activeRaw = "";
  }

  function appendAssistantToken(text: string): void {
    endThinking();
    if (!activeAssistant) {
      activeAssistant = document.createElement("div");
      activeAssistant.className = "line assistant";
      log.appendChild(activeAssistant);
      activeRaw = "";
    }
    activeRaw += text;
    showAssistant(activeAssistant, activeRaw);
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
      endThinking();
      const line = addLine(
        "tool",
        `tool: ${name}${depth ? " (subagent)" : ""}`,
      );
      if (burstActive) line.className += " burst";
    },
    setBurst(active: boolean): void {
      if (active && !burstActive) {
        flushAssistant();
        endThinking();
        addLine("burst", "⚡ burst: running the plan without thinking");
      }
      burstActive = active;
    },
    finishThinking(): void {
      endThinking();
    },
    flushAssistant,
    clear(): void {
      log.textContent = "";
      activeAssistant = null;
      activeRaw = "";
      endThinking();
    },
  };
}
