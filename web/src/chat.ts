// The open chats: each one's history, log and tab, and the streaming of a reply into its log. The chat form itself is
// wired in app.ts.

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
  | { type: "step"; text: string }
  | { type: "done"; answer: string; user_message?: string | null; told?: string[]; summary?: string | null; summary_failed?: string | null; profile?: string | null; workflow?: Message[] | null }
  | { type: "error"; error: string; ran?: string[] };

// The error, with the tool calls that ran before it: their effects remain even though the turn did not finish.
function describeFailure(error: string, ran?: string[] | null): string {
  if (!ran || ran.length === 0) {
    return error;
  }
  return `${error} ${ran.length} tool call(s) ran before this, and their effects remain: ${ran.join("; ")}`;
}

type Done = Extract<StreamEvent, { type: "done" }>;

// One open chat. A chat that is not shown keeps streaming a reply into its log, so switching away does not stop it.
interface Chat {
  conversation: Message[];
  // The switched-off tools the model has been told about in this conversation.
  told: string[];
  // The name this conversation autosaves under. It is picked at the first completed turn, and New or Load clears it so
  // the next turn starts a new saved session.
  autosaveName: string | null;
  log: HTMLDivElement;
  tab: HTMLDivElement;
  // The request in flight, if any: Stop aborts it. Aborting closes the connection, and the server stops the turn.
  inFlight: AbortController | null;
  // True from the moment a message is sent until its reply ends.
  busy: boolean;
  // Set when the chat's tab is closed. A message still waiting on the default profile is then not sent.
  closed: boolean;
  // The default profile's request. The first message waits for it. Stop cancels it.
  defaultProfile: Promise<void>;
  defaultAbort: AbortController | null;
}

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

const logHost = document.getElementById("log") as HTMLDivElement;
const chatTabs = document.getElementById("chat-tabs") as HTMLDivElement;
const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("input") as HTMLInputElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;
const stopButton = document.getElementById("stop") as HTMLButtonElement;

const chats: Chat[] = [];
// The chat shown in the page. Every chat is shown in turn, so this is always set once the page has started.
let active: Chat;
let chatCount = 0;

// Creates a chat with its own log and tab. It is not shown until showChat is called. Closing its tab calls onClose.
function createChat(onClose: (chat: Chat) => void): Chat {
  const log = document.createElement("div");
  log.className = "chat-log";
  log.hidden = true;
  logHost.append(log);

  chatCount += 1;
  const tab = createTab(
    chatTabs,
    `Chat ${chatCount}`,
    () => showChat(chat),
    () => onClose(chat),
  );

  const chat: Chat = {
    conversation: [],
    told: [],
    autosaveName: null,
    log,
    tab,
    inFlight: null,
    busy: false,
    closed: false,
    defaultProfile: Promise.resolve(),
    defaultAbort: null,
  };
  chats.push(chat);
  return chat;
}

// Shows one chat in the chat's space: its log and tab are the ones shown, and the form follows its reply. A file that
// was shown in that space is put away.
function showChat(chat: Chat): void {
  active = chat;
  for (const other of chats) {
    other.log.hidden = other !== chat;
    setTabActive(other.tab, other === chat);
  }
  hideFiles();
  refreshForm();
  scrollToEnd(chat);
  saveChats();
}

// The form follows the shown chat: it is off while that chat's reply is pending, and Stop shows while it is streaming.
function refreshForm(): void {
  input.disabled = active.busy;
  sendButton.hidden = active.inFlight !== null;
  stopButton.hidden = active.inFlight === null;
}

// The open chats and which one is shown, kept in this browser so a reload brings them back. Storage can be blocked, in
// which case the chats last for this page load only.
const CHATS_KEY = "vise-chats";
function saveChats(): void {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify({ names: chats.map((chat) => chat.autosaveName), active: chats.indexOf(active) }));
  } catch {
    // Not saved: the chats last for this page load only.
  }
}

function addEntry(chat: Chat, kind: Role | "error"): HTMLDivElement {
  const entry = document.createElement("div");
  entry.className = kind;
  chat.log.appendChild(entry);
  return entry;
}

// Keeps the end of a chat in view, when that chat is the one shown.
function scrollToEnd(chat: Chat): void {
  if (chat === active) {
    logHost.scrollTop = logHost.scrollHeight;
  }
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
  told: string[],
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
