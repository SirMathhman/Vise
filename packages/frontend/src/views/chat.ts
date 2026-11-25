import type { ChatRequest } from "common";
import { parseChatStreamEvent } from "common";
import { openChat } from "../api";
import { errorMessage, requireElement } from "../dom";
import { hasModel } from "./models";

const ACTIVE_MODEL_KEY = "vise.activeModel";
const modelInput = requireElement("model-input") as HTMLInputElement;
const chatMessage = requireElement("chat-message") as HTMLTextAreaElement;
const chatSend = requireElement("chat-send") as HTMLButtonElement;
const chatStatus = requireElement("chat-status") as HTMLParagraphElement;
const chatReply = requireElement("chat-reply") as HTMLDivElement;

// The active model is remembered in this browser only.
function readActiveModel(): string {
  try {
    return localStorage.getItem(ACTIVE_MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeActiveModel(id: string): void {
  try {
    localStorage.setItem(ACTIVE_MODEL_KEY, id);
  } catch {
    // Storage is unavailable; the choice still applies until the page reloads.
  }
}

// Applies one server-sent event payload. Returns true when the reply is over.
function applyChatPayload(payload: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    value = undefined;
  }
  const parsed = parseChatStreamEvent(value);
  if (!parsed.ok) {
    chatStatus.textContent = `Unavailable: ${parsed.error}`;
    return true;
  }
  const event = parsed.value;
  if (event.type === "delta") {
    chatReply.textContent += event.text;
    return false;
  }
  chatStatus.textContent =
    event.type === "error" ? `Unavailable: ${event.message}` : "Done";
  return true;
}

// Reads the server-sent events until the reply's done or error event.
async function readReply(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let chunk = await reader.read();
  while (!chunk.done) {
    pending += decoder.decode(chunk.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (
        line.startsWith("data:") &&
        applyChatPayload(line.slice("data:".length))
      ) {
        await reader.cancel();
        return;
      }
    }
    chunk = await reader.read();
  }
  chatStatus.textContent = "The reply was cut off";
}

// Sends one message to the active model and shows the reply as it streams in.
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

  const request: ChatRequest = { model, message };
  chatSend.disabled = true;
  chatReply.textContent = "";
  chatStatus.textContent = "Waiting for reply…";
  try {
    const opened = await openChat(request);
    if (!opened.ok) {
      chatStatus.textContent = `Unavailable: ${opened.error}`;
      return;
    }
    await readReply(opened.value);
  } catch (failure) {
    chatStatus.textContent = `Unavailable: ${errorMessage(failure)}`;
  } finally {
    chatSend.disabled = false;
  }
}

export function initChat(): void {
  modelInput.value = readActiveModel();
  modelInput.addEventListener("change", () => {
    writeActiveModel(modelInput.value.trim());
  });
  chatSend.addEventListener("click", () => void sendMessage());
}
