import { make } from "../dom.ts";
/** What a `call_raw` message carries (see `src/web/inspect/inspect.ts`). */
export interface CallRawMessage {
  type: string;
  none?: boolean;
  request?: number;
  purpose?: string;
  model?: string;
  state?: "running" | "done" | "stopped" | "error";
  stopReason?: string;
  detail?: string;
  ms?: number;
  promptTokens?: number;
  tokens?: number;
  tokensPerSec?: number;
  chars?: number;
  tail?: string;
  reasoning?: string;
  loop?: { period: number; repeats: number; sample?: string };
  finishReason?: string;
  recent?: { request: number; purpose: string; state: string; stopReason?: string; tokens: number; ms: number }[];
}

/** How a call ended, in words (running, or why it was cut short). Pure. */
export function describeEnd(
  state: CallRawMessage["state"],
  stopReason?: string,
  finishReason?: string,
): string {
  if (state === "running") return "Running";
  if (stopReason === "loop") return "Stopped: it was repeating itself";
  if (stopReason === "token_cap") return "Stopped: it reached the token limit";
  if (stopReason === "interrupted") return "Interrupted";
  if (state === "error") return "Failed";
  return finishReason ? `Finished (${finishReason})` : "Finished";
}

/** The panel's parts. */
function buildPanel() {
  const panel = make("aside", "inspector hidden");
  panel.setAttribute("aria-label", "Model output");
  const title = make("strong", "inspector-title", "Model output");
  const status = make("span", "badge inspector-state");
  const close = make("button", "btn btn--ghost btn--icon btn--sm", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  const head = make("div", "inspector-head");
  head.append(title, status, close);
  const stats = make("div", "inspector-stats");
  const loop = make("div", "notice inspector-loop hidden");
  const picker = make("select", "field inspector-pick");
  picker.setAttribute("aria-label", "Model call");
  const outputTab = make("button", "btn btn--sm", "Output");
  const reasoningTab = make("button", "btn btn--sm", "Reasoning");
  outputTab.type = reasoningTab.type = "button";
  const tabs = make("div", "inspector-tabs");
  tabs.append(outputTab, reasoningTab);
  const raw = make("pre", "inspector-raw");
  raw.tabIndex = 0;
  const stopBtn = make("button", "btn btn--danger btn--sm", "Stop");
  const copyBtn = make("button", "btn btn--sm", "Copy");
  stopBtn.type = copyBtn.type = "button";
  const actions = make("div", "actions inspector-actions");
  actions.append(stopBtn, copyBtn, make("span", "hint", "More: /audit calls"));
  panel.append(head, picker, stats, loop, tabs, raw, actions);
  document.body.appendChild(panel);
  return { panel, title, status, close, stats, loop, picker, outputTab, reasoningTab, raw, stopBtn, copyBtn };
}
type Ui = ReturnType<typeof buildPanel>;

const count = (n: number | undefined): string => (n ?? 0).toLocaleString("en-US");

/** Show one call's numbers, what repeats at its end, and the text chosen. */
function drawCall(ui: Ui, m: CallRawMessage | undefined, text: string, follow: boolean): void {
  if (!m || m.none) {
    ui.status.textContent = "";
    ui.stats.textContent = "No model call yet. Output appears here while the agent writes.";
    ui.raw.textContent = "";
    ui.loop.classList.add("hidden");
    return;
  }
  ui.status.textContent = describeEnd(m.state, m.stopReason, m.finishReason);
  ui.status.dataset["state"] = m.state === "running" ? "running" : m.stopReason ? "stopped" : (m.state ?? "");
  ui.title.textContent = `#${m.request} · ${m.purpose}`;
  ui.stats.textContent = [
    `${count(m.tokens)} tokens`,
    m.state === "running" && m.tokensPerSec ? `${m.tokensPerSec} tokens/s` : "",
    `${((m.ms ?? 0) / 1000).toFixed(1)} s`,
    m.promptTokens !== undefined ? `prompt ${count(m.promptTokens)}` : "",
    `${count(m.chars)} characters`,
  ].filter(Boolean).join(" · ");
  const note = m.loop
    ? `The end of this call is a ${m.loop.period}-character chunk repeated about ${m.loop.repeats} times: ${JSON.stringify(m.loop.sample ?? "")}`
    : m.state !== "running" ? m.detail : undefined;
  ui.loop.textContent = note ?? "";
  ui.loop.classList.toggle("hidden", !note);
  ui.stopBtn.disabled = m.state !== "running";
  const atEnd = ui.raw.scrollHeight - ui.raw.scrollTop - ui.raw.clientHeight < 24;
  if (ui.raw.textContent !== text) ui.raw.textContent = text;
  if (follow && atEnd) ui.raw.scrollTop = ui.raw.scrollHeight;
}

/** The list of recent calls the viewer can pick from (the first choice follows the newest). */
function drawPicker(picker: HTMLSelectElement, recent: CallRawMessage["recent"], watching: number | undefined): void {
  picker.textContent = "";
  picker.append(new Option("Follow the newest call", ""));
  for (const call of recent ?? []) {
    const end = describeEnd(call.state as CallRawMessage["state"], call.stopReason);
    picker.append(new Option(`#${call.request} ${call.purpose} · ${end} · ${call.tokens} tokens`, String(call.request)));
  }
  picker.value = String(watching ?? "");
}

/**
 * A live look at what the model is writing: the end of the raw text of the
 * running call (tool calls included, which the chat never shows), how many
 * tokens it has written and how fast, what repeats at its end, and Stop. It
 * subscribes to the server while open (`inspect_start`), follows the newest
 * call unless one is picked from the list of recent calls, and keeps the last
 * call on screen after it ends, with why it ended.
 */
export function createCallInspector(
  send: (msg: Record<string, unknown>) => void,
  stop: () => void,
): { open(request?: number): void; close(): void; isOpen(): boolean; handle(message: CallRawMessage): boolean } {
  const ui = buildPanel();
  let watching: number | undefined;
  let showReasoning = false;
  let last: CallRawMessage | undefined;
  let follow = true;
  const shownText = (): string => (showReasoning ? last?.reasoning : last?.tail) ?? "";
  const draw = (): void => drawCall(ui, last, shownText(), follow);
  const subscribe = (): void => send({ type: "inspect_start", request: watching });
  const setTab = (reasoning: boolean): void => {
    showReasoning = reasoning;
    ui.outputTab.setAttribute("aria-pressed", String(!reasoning));
    ui.reasoningTab.setAttribute("aria-pressed", String(reasoning));
    draw();
  };
  const closePanel = (): void => {
    ui.panel.classList.add("hidden");
    send({ type: "inspect_stop" });
  };
  ui.outputTab.addEventListener("click", () => setTab(false));
  ui.reasoningTab.addEventListener("click", () => setTab(true));
  ui.picker.addEventListener("change", () => {
    watching = ui.picker.value === "" ? undefined : Number(ui.picker.value);
    subscribe();
  });
  ui.raw.addEventListener("scroll", () => {
    follow = ui.raw.scrollHeight - ui.raw.scrollTop - ui.raw.clientHeight < 24;
  });
  ui.stopBtn.addEventListener("click", stop);
  ui.copyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(shownText()).catch(() => undefined);
  });
  ui.close.addEventListener("click", closePanel);
  setTab(false);

  return {
    open(request) {
      watching = request;
      follow = true;
      ui.panel.classList.remove("hidden");
      subscribe();
      ui.raw.focus({ preventScroll: true });
    },
    close: closePanel,
    isOpen: () => !ui.panel.classList.contains("hidden"),
    handle(message) {
      if (message.type !== "call_raw") return false;
      last = message;
      drawPicker(ui.picker, message.recent, watching);
      draw();
      return true;
    },
  };
}
