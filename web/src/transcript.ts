export interface TranscriptView {
  addLine(cls: string, text: string): HTMLDivElement;
  appendAssistantToken(text: string): void;
  appendThinkingToken(text: string): void;
  appendToolCall(name: string, depth?: number): void;
  /** Append a subagent's streamed reply (a dimmed, indented block). */
  appendSubagentToken(text: string): void;
  /** Mark subsequent tool calls as part of a burst (no thinking between). */
  setBurst(active: boolean): void;
  finishThinking(): void;
  flushAssistant(): void;
  clear(): void;
}

/** Show `raw` as sanitized HTML when a renderer is given, else verbatim. */
function showMarkdown(
  element: HTMLElement,
  raw: string,
  renderHtml?: (markdown: string) => string,
): void {
  if (renderHtml) element.innerHTML = renderHtml(raw);
  else element.textContent = raw;
}

/** Click a thinking line to open or close it. */
function enableThinkingToggle(log: HTMLElement): void {
  log.addEventListener?.("click", (event) => {
    const line = (event.target as HTMLElement | null)?.closest?.(
      ".line.thinking",
    );
    if (!(line instanceof HTMLElement)) return;
    line.className = line.className.endsWith(" open")
      ? line.className.replace(/ open$/, "")
      : `${line.className} open`;
  });
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
  let activeSubagent: HTMLElement | null = null;
  let subagentRaw = "";

  // Thinking lines start collapsed and collapse again when the thinking ends.
  function endThinking(): void {
    if (activeThinking) {
      activeThinking.className = activeThinking.className.replace(/ open$/, "");
    }
    activeThinking = null;
  }

  enableThinkingToggle(log);

  function addLine(cls: string, text: string): HTMLDivElement {
    const div = document.createElement("div");
    div.className = `line ${cls}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  const showAssistant = (element: HTMLElement, raw: string): void =>
    showMarkdown(element, raw, renderHtml);

  function appendSubagentToken(text: string): void {
    flushAssistant(true);
    endThinking();
    if (!activeSubagent) {
      activeSubagent = document.createElement("div");
      activeSubagent.className = "line assistant subagent";
      log.appendChild(activeSubagent);
      subagentRaw = "";
    }
    subagentRaw += text;
    showAssistant(activeSubagent, subagentRaw);
    log.scrollTop = log.scrollHeight;
  }

  // `keepSubagent` lets a subagent block keep growing across its tokens.
  function flushAssistant(keepSubagent = false): void {
    if (!keepSubagent) activeSubagent = null;
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
    appendSubagentToken,
    appendThinkingToken,
    appendToolCall(label: string, depth?: number): void {
      flushAssistant();
      endThinking();
      const line = addLine("tool", `${label}${depth ? " (subagent)" : ""}`);
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
