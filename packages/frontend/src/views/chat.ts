import type { ChatMessage, ChatStreamEvent, Result } from "common";
import {
  err,
  fitsBudget,
  ok,
  parseChatMessageList,
  parseChatStreamEvent,
  trimToBudget,
} from "common";
import { openChat } from "../api";
import { errorMessage, requireElement } from "../dom";
import { hasModel } from "./models";

const ACTIVE_MODEL_KEY = "vise.activeModel";
const HISTORY_KEY = "vise.conversation";
const modelInput = requireElement("model-input") as HTMLInputElement;
const conversation = requireElement("conversation") as HTMLDivElement;
const chatMessage = requireElement("chat-message") as HTMLTextAreaElement;
const chatSend = requireElement("chat-send") as HTMLButtonElement;
const chatNew = requireElement("chat-new") as HTMLButtonElement;
const chatStatus = requireElement("chat-status") as HTMLParagraphElement;

// The conversation so far, and the exchange currently streaming in.
let history: ChatMessage[] = [];
let inFlight: { user: string; reply: string } | undefined;

// Storage is optional: without it the conversation lasts until the page reloads.
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Storage is unavailable; the change still applies until the page reloads.
  }
}

function loadHistory(): ChatMessage[] {
  const raw = readStorage(HISTORY_KEY);
  if (raw === null) {
    return [];
  }
  try {
    const parsed = parseChatMessageList(JSON.parse(raw));
    return parsed.ok ? trimToBudget(parsed.value) : [];
  } catch {
    return [];
  }
}

function saveHistory(): void {
  writeStorage(
    HISTORY_KEY,
    history.length === 0 ? null : JSON.stringify(history),
  );
}

function bubble(message: ChatMessage): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `bubble ${message.role}`;
  el.textContent = message.content;
  return el;
}

// Redraws the conversation and keeps the newest message in view.
function renderConversation(): void {
  const items: ChatMessage[] = [...history];
  if (inFlight) {
    items.push({ role: "user", content: inFlight.user });
    if (inFlight.reply !== "") {
      items.push({ role: "assistant", content: inFlight.reply });
    }
  }
  conversation.replaceChildren(...items.map(bubble));
  conversation.scrollTop = conversation.scrollHeight;
}

// The active model is remembered in this browser only.
function readActiveModel(): string {
  return readStorage(ACTIVE_MODEL_KEY) ?? "";
}

// Reads the server-sent events of one reply. Returns the full reply text,
// or the error that ended it.
async function readReply(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<Result<string, string>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let reply = "";
  let chunk = await reader.read();
  while (!chunk.done) {
    pending += decoder.decode(chunk.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const event = parseEventLine(line.slice("data:".length));
      if (!event.ok) {
        await reader.cancel();
        return err(event.error);
      }
      if (event.value.type === "delta") {
        reply += event.value.text;
        onDelta(event.value.text);
      } else if (event.value.type === "done") {
        await reader.cancel();
        return ok(reply);
      } else {
        await reader.cancel();
        return err(event.value.message);
      }
    }
    chunk = await reader.read();
  }
  return err("The reply was cut off");
}

// Parses the JSON after "data:" in one server-sent event.
function parseEventLine(payload: string): Result<ChatStreamEvent, string> {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return err("Unexpected chat event");
  }
  return parseChatStreamEvent(value);
}

// Sends the conversation with one new message and records the reply when it completes.
async function sendMessage(): Promise<void> {
  const model = modelInput.value.trim();
  const message = chatMessage.value.trim();
  chatStatus.textContent = "";
  if (!hasModel(model)) {
    chatStatus.textContent = "Choose a model from the list.";
    return;
  }
  if (!message) {
    chatStatus.textContent = "Type a message first.";
    return;
  }

  // Older messages are dropped, oldest first, so the conversation fits the limit.
  const full: ChatMessage[] = [...history, { role: "user", content: message }];
  const messages = trimToBudget(full);
  if (!fitsBudget(messages)) {
    chatStatus.textContent = "That message is too long to send.";
    return;
  }
  const dropped = messages.length < full.length;
  inFlight = { user: message, reply: "" };
  chatMessage.value = "";
  chatSend.disabled = true;
  chatStatus.textContent = "Waiting for reply…";
  renderConversation();
  try {
    const opened = await openChat({ model, messages });
    const outcome = opened.ok
      ? await readReply(opened.value, (text) => {
          if (inFlight) {
            inFlight.reply += text;
          }
          renderConversation();
        })
      : opened;
    if (outcome.ok) {
      history = [...messages, { role: "assistant", content: outcome.value }];
      saveHistory();
      chatStatus.textContent = dropped
        ? "Done. Older messages were dropped to fit the conversation limit."
        : "Done";
    } else {
      chatStatus.textContent = `Unavailable: ${outcome.error}`;
    }
  } catch (failure) {
    chatStatus.textContent = `Unavailable: ${errorMessage(failure)}`;
  } finally {
    inFlight = undefined;
    chatSend.disabled = false;
    renderConversation();
  }
}

function newConversation(): void {
  history = [];
  saveHistory();
  chatStatus.textContent = "";
  renderConversation();
}

export function initChat(): void {
  history = loadHistory();
  modelInput.value = readActiveModel();
  modelInput.addEventListener("change", () => {
    writeStorage(ACTIVE_MODEL_KEY, modelInput.value.trim());
  });
  chatSend.addEventListener("click", () => void sendMessage());
  chatNew.addEventListener("click", newConversation);
  renderConversation();
}
