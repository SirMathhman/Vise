type Role = "user" | "assistant" | "summary" | "summary_failed" | "profile";

interface Message {
  role: Role;
  content: string;
}

type StreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "tool"; text: string }
  | { type: "subagent_start"; profile: string; task: string }
  | { type: "nested"; event: StreamEvent }
  | { type: "subagent_end"; failed: boolean }
  | { type: "done"; answer: string; user_message?: string | null; told?: string[]; summary?: string | null; summary_failed?: string | null; profile?: string | null }
  | { type: "error"; error: string; ran?: string[] };

// The error, with the tool calls that ran before it: their effects remain even though the turn did not finish.
function describeFailure(error: string, ran?: string[] | null): string {
  if (!ran || ran.length === 0) {
    return error;
  }
  return `${error} ${ran.length} tool call(s) ran before this, and their effects remain: ${ran.join("; ")}`;
}

type Done = Extract<StreamEvent, { type: "done" }>;

const conversation: Message[] = [];
// The switched-off tools the model has been told about in this conversation.
let told: string[] = [];

// This tab's session: its switched-off tools live on the server under this id. It survives a reload of the tab and
// is dropped when the tab closes. Storage can be blocked, in which case the session lasts for this page load.
const SESSION_KEY = "vise-session";
function sessionId(): string {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) return stored;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}
const session = sessionId();

const log = document.getElementById("log") as HTMLDivElement;
const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("input") as HTMLInputElement;
const newButton = document.getElementById("new") as HTMLButtonElement;
const stopButton = document.getElementById("stop") as HTMLButtonElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;
// The request in flight, if any: Stop aborts it. Aborting closes the connection, and the server stops the turn.
let inFlight: AbortController | null = null;

function addEntry(kind: Role | "error"): HTMLDivElement {
  const entry = document.createElement("div");
  entry.className = kind;
  log.appendChild(entry);
  return entry;
}

function scrollToEnd(): void {
  log.scrollTop = log.scrollHeight;
}

// A tool call's line in the reply.
function toolLine(text: string): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "tool";
  line.textContent = `[tool] ${text}`;
  return line;
}

// A block that holds markdown text, which is rendered again as each piece arrives.
function markdownBlock(): HTMLDivElement {
  const block = document.createElement("div");
  block.className = "markdown";
  return block;
}

async function streamChat(
  messages: Message[],
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<Done> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, told, session }),
      signal,
    });
  } catch {
    throw new Error(
      `Could not reach the Vise server at ${location.origin}. Check that "vise web" is still running, then try again.`,
    );
  }
  if (!res.ok || res.body === null) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; ran?: string[] };
    throw new Error(describeFailure(data.error ?? `HTTP ${res.status}`, data.ran));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read().catch(() => {
      throw new Error("The connection dropped partway through the reply. Try again.");
    });
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
        throw new Error(describeFailure(event.error, event.ran));
      }
      if (event.type === "done") {
        return event;
      }
      onEvent(event);
    }
  }
  throw new Error("The reply ended before it finished. Try again.");
}

// One subagent run in a reply: a block that is open while it runs and folds away when it finishes. Its reasoning,
// answer text and tool lines appear in the order the subagent produced them.
interface Subagent {
  block: HTMLDetailsElement;
  summary: HTMLElement;
  label: string;
  // The part being streamed into, and its kind. A tool line ends the part, so the next text starts a new one.
  part: HTMLDivElement | null;
  partKind: "reasoning" | "content" | null;
  raw: string;
}

function openSubagent(bubble: HTMLElement, start: { profile: string; task: string }): Subagent {
  const block = document.createElement("details");
  block.className = "subagent";
  block.open = true;
  const summary = document.createElement("summary");
  const label = `${start.profile}: ${start.task}`;
  summary.textContent = `Subagent running, ${label}`;
  block.append(summary);
  bubble.append(block);
  return { block, summary, label, part: null, partKind: null, raw: "" };
}

function subagentPart(sub: Subagent, kind: "reasoning" | "content"): HTMLDivElement {
  if (sub.part === null || sub.partKind !== kind) {
    const part = document.createElement("div");
    part.className = kind === "content" ? "markdown" : "thinking";
    sub.block.append(part);
    sub.part = part;
    sub.partKind = kind;
    sub.raw = "";
  }
  return sub.part;
}

function renderSubagentStep(sub: Subagent, step: StreamEvent): void {
  if (step.type === "reasoning") {
    subagentPart(sub, "reasoning").textContent += step.text;
  } else if (step.type === "content") {
    const part = subagentPart(sub, "content");
    sub.raw += step.text;
    part.innerHTML = renderMarkdown(sub.raw);
  } else if (step.type === "tool") {
    sub.block.append(toolLine(step.text));
    sub.part = null;
    sub.partKind = null;
  }
}

// A finished subagent folds away, unless it failed, so the reason stays in view.
function closeSubagent(sub: Subagent, failed: boolean): void {
  sub.summary.textContent = failed ? `Subagent failed, ${sub.label}` : `Subagent finished, ${sub.label}`;
  sub.block.open = failed;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text === "") {
    return;
  }

  // The default profile must be in place before the user's message joins the conversation.
  input.disabled = true;
  await defaultProfile;
  input.value = "";
  // Tool commands are answered by the server and kept out of the conversation.
  const command = /^\/(tools|enable|disable|notes|profile)(\s|$)/.test(text);
  if (!command) {
    conversation.push({ role: "user", content: text });
  }
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
  let answerText = markdownBlock();
  // The reply so far as the model wrote it. It is rendered again as each piece arrives.
  let answerRaw = "";
  bubble.append(thinking, answerText);

  try {
    const messages = command ? [...conversation, { role: "user" as const, content: text }] : conversation;
    const controller = new AbortController();
    inFlight = controller;
    sendButton.hidden = true;
    stopButton.hidden = false;
    let subagent: Subagent | null = null;
    const done = await streamChat(messages, (streamed) => {
      if (streamed.type === "reasoning") {
        thinking.hidden = false;
        thinkingText.textContent += streamed.text;
      } else if (streamed.type === "content") {
        answerRaw += streamed.text;
        answerText.innerHTML = renderMarkdown(answerRaw);
      } else if (streamed.type === "tool") {
        // Text after a tool call goes in a new block below it, so the order matches the stream.
        answerText = markdownBlock();
        answerRaw = "";
        bubble.append(toolLine(streamed.text), answerText);
      } else if (streamed.type === "subagent_start") {
        subagent = openSubagent(bubble, streamed);
      } else if (streamed.type === "nested") {
        if (subagent !== null) {
          renderSubagentStep(subagent, streamed.event);
        }
      } else if (streamed.type === "subagent_end") {
        if (subagent !== null) {
          closeSubagent(subagent, streamed.failed);
        }
        subagent = null;
        // Text after a subagent goes in a new block below it, as text after a tool call does.
        answerText = markdownBlock();
        answerRaw = "";
        bubble.append(answerText);
      }
      scrollToEnd();
    }, controller.signal);
    if (done.profile != null) {
      // A chosen profile's instructions join the conversation, so the later requests keep following them.
      conversation.push({ role: "profile", content: done.profile });
    }
    if (!command) {
      // The server may have added a note about switch changes to this user message, and returns the
      // record of switches the model now knows about. Both are kept only once the reply has arrived.
      if (done.user_message != null) {
        conversation[conversation.length - 1].content = done.user_message;
      }
      if (done.told) {
        told = done.told;
      }
      conversation.push({ role: "assistant", content: done.answer });
      // A summary is appended after the reply. The earlier messages stay in the log, unchanged.
      if (done.summary != null) {
        conversation.push({ role: "summary", content: done.summary });
        addEntry("summary").textContent = "Earlier conversation summarized.";
      } else if (done.summary_failed != null) {
        conversation.push({ role: "summary_failed", content: done.summary_failed });
        addEntry("summary").textContent = "Could not summarize the conversation. It will be tried again later.";
      }
      autosaveTurn();
    }
  } catch (err) {
    if (!command) {
      conversation.pop();
    }
    if (inFlight?.signal.aborted) {
      // Stopped by the user: what streamed stays on screen, but the turn is not kept, as a failed one is not.
      addEntry("summary").textContent =
        "Stopped. Tool calls shown above may already have run, and their effects remain. This turn was not kept in the conversation.";
    } else {
      if (answerText.textContent === "" && thinkingText.textContent === "") {
        bubble.remove();
      }
      addEntry("error").textContent = errorMessage(err);
    }
  } finally {
    inFlight = null;
    sendButton.hidden = false;
    stopButton.hidden = true;
    input.disabled = false;
    input.focus();
    // A typed /enable or /disable changes a switch on the server, so the panel is redrawn from it.
    void refreshTools();
    scrollToEnd();
  }
});

stopButton.addEventListener("click", () => {
  inFlight?.abort();
  defaultAbort?.abort();
});

newButton.addEventListener("click", () => {
  conversation.length = 0;
  told = [];
  autosaveName = null;
  log.replaceChildren();
  void applyDefaultProfile();
});

// The default profile's request, started on load and on New. The first message waits for it, so the profile's
// instructions join the conversation before the user's message does. Stop cancels it.
let defaultProfile: Promise<void> = Promise.resolve();
let defaultAbort: AbortController | null = null;

// Starts the conversation with the built-in default profile. The server applies its tools and returns its
// instructions, if it has any, which join the conversation. Nothing is shown in the log.
function applyDefaultProfile(): Promise<void> {
  const controller = new AbortController();
  defaultAbort = controller;
  defaultProfile = (async () => {
    try {
      const done = await streamChat([{ role: "user", content: "/profile default" }], () => {}, controller.signal);
      if (done.profile != null) {
        conversation.push({ role: "profile", content: done.profile });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        addEntry("error").textContent = errorMessage(err);
      }
    }
    void refreshTools();
  })();
  return defaultProfile;
}


// The two panels beside the chat whose widths the user drags: Tools on the right, the open files on the left. Each
// divider sets its panel's width, which is kept in this browser. A panel never takes more than the window leaves it
// after the chat's minimum and the other panel, so the two never push each other off screen.
interface ResizablePanel {
  panel: HTMLElement;
  divider: HTMLElement;
  cssVar: string;
  storageKey: string;
  min: number;
  // The pointer movement that widens the panel: 1 for a panel left of its divider, -1 for one right of it.
  direction: 1 | -1;
  // The width the user chose, or 0 for the default. It is kept as it is, so it comes back when the window grows.
  chosen: number;
}

const MIN_TOOLS_PX = 160;
const MIN_VIEWERS_PX = 224;
// The chat's preferred width, 24rem. The panels leave it this much when they can, and it gives way in a narrow window.
const CHAT_PX = 384;
const layout = document.querySelector(".layout") as HTMLDivElement;
const main = document.querySelector("main") as HTMLElement;
const toolsPanel: ResizablePanel = {
  panel: document.querySelector("aside") as HTMLElement,
  divider: document.getElementById("divider") as HTMLDivElement,
  cssVar: "--tools-width",
  storageKey: "vise-tools-width",
  min: MIN_TOOLS_PX,
  direction: -1,
  chosen: 0,
};
const viewersPanel: ResizablePanel = {
  panel: viewers,
  divider: document.getElementById("viewers-divider") as HTMLDivElement,
  cssVar: "--viewers-width",
  storageKey: "vise-viewers-width",
  min: MIN_VIEWERS_PX,
  direction: 1,
  chosen: 0,
};

// The most a panel may take: the window less the chat's preferred width and every other panel as it is now shown. A
// panel still gets its own minimum when the window is too narrow, and the chat gives way instead.
function roomFor(resizable: ResizablePanel): number {
  let others = 0;
  for (const child of Array.from(layout.children) as HTMLElement[]) {
    if (child !== main && child !== resizable.panel) {
      others += child.offsetWidth;
    }
  }
  return layout.clientWidth - others - CHAT_PX;
}

// Sets each chosen width to what fits. Tools is set first, so the files take their room from it as it is now shown.
function applyPanelWidths(): void {
  for (const resizable of [toolsPanel, viewersPanel]) {
    if (resizable.chosen > 0) {
      const px = Math.max(resizable.min, Math.min(resizable.chosen, roomFor(resizable)));
      document.documentElement.style.setProperty(resizable.cssVar, `${px}px`);
    }
  }
}

// Dragging a divider sets its panel's width. The width follows the pointer from where the drag began.
function watchDivider(resizable: ResizablePanel): void {
  let drag: { x: number; width: number } | null = null;
  resizable.divider.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, width: resizable.panel.getBoundingClientRect().width };
    resizable.divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  resizable.divider.addEventListener("pointermove", (event) => {
    if (drag !== null) {
      resizable.chosen = drag.width + resizable.direction * (event.clientX - drag.x);
      applyPanelWidths();
    }
  });
  function endDrag(): void {
    if (drag === null) {
      return;
    }
    drag = null;
    try {
      localStorage.setItem(resizable.storageKey, String(resizable.chosen));
    } catch {
      // Not saved: the width lasts for this page load only.
    }
  }
  resizable.divider.addEventListener("pointerup", endDrag);
  resizable.divider.addEventListener("pointercancel", endDrag);
}

// Restores the width this browser last used. Storage can be blocked, in which case the default width is used.
for (const resizable of [toolsPanel, viewersPanel]) {
  try {
    const stored = Number(localStorage.getItem(resizable.storageKey));
    if (stored > 0) {
      resizable.chosen = stored;
    }
  } catch {
    // The default width stays.
  }
  watchDivider(resizable);
}
applyPanelWidths();

void refreshTools();
void refreshNotes();
void refreshSessions();
void refreshFiles();
void applyDefaultProfile();

// A narrower window clamps the shown width without changing the chosen one, and nothing is saved here.
window.addEventListener("resize", applyPanelWidths);
