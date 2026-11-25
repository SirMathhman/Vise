import type {
  ApprovalDecision,
  ChatMessage,
  ChatStreamEvent,
  Result,
} from "common";
import {
  ApprovalAckSchema,
  ChatMessageListSchema,
  ChatStreamEventSchema,
  budgetUsage,
  conversationLimit,
  describeParseError,
  err,
  fitsBudget,
  ok,
  parseJson,
  trimToBudget,
} from "common";
import { apiJson, openChat } from "../api";
import { errorMessage, requireElement } from "../dom";
import { contextLengthOf } from "./models";

const ACTIVE_MODEL_KEY = "vise.activeModel";
const HISTORY_KEY = "vise.conversation";
const modelInput = requireElement("model-input") as HTMLInputElement;
const conversation = requireElement("conversation") as HTMLDivElement;
const chatMessage = requireElement("chat-message") as HTMLTextAreaElement;
const chatSend = requireElement("chat-send") as HTMLButtonElement;
const chatNew = requireElement("chat-new") as HTMLButtonElement;
const chatStatus = requireElement("chat-status") as HTMLParagraphElement;
const budgetBar = requireElement("budget-bar") as HTMLDivElement;
const budgetLabel = requireElement("budget-label") as HTMLParagraphElement;

// A proposed change that waits for the user's answer.
interface PendingApproval {
  id: string;
  title: string;
  body: string;
}

// The conversation so far, and the exchange currently streaming in.
let history: ChatMessage[] = [];
let inFlight:
  | { userMessage: ChatMessage; reply: string; approvals: PendingApproval[] }
  | undefined;

// The exact prompt tokens OpenRouter counted for the last request, and the user message that
// request was made for. Held for this page only.
let measured: { tokens: number; anchor: ChatMessage } | undefined;

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
  const parsed = parseJson(ChatMessageListSchema, raw);
  return parsed.ok ? parsed.value : [];
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

// The card for one proposed change, with the choice to approve or reject it.
function approvalCard(approval: PendingApproval): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "approval";
  const title = document.createElement("p");
  title.className = "approval-title";
  title.textContent = approval.title;
  const body = document.createElement("pre");
  body.textContent = approval.body;
  const approve = document.createElement("button");
  approve.type = "button";
  approve.textContent = "Approve";
  approve.addEventListener("click", () => void answer(approval.id, true));
  const reject = document.createElement("button");
  reject.type = "button";
  reject.textContent = "Reject";
  reject.addEventListener("click", () => void answer(approval.id, false));
  const actions = document.createElement("div");
  actions.className = "row";
  actions.append(approve, reject);
  card.append(title, body, actions);
  return card;
}

// Redraws the conversation and keeps the newest message in view.
function renderConversation(): void {
  const items: ChatMessage[] = [...history];
  if (inFlight) {
    items.push(inFlight.userMessage);
    if (inFlight.reply !== "") {
      items.push({ role: "assistant", content: inFlight.reply });
    }
  }
  const cards = inFlight ? inFlight.approvals.map(approvalCard) : [];
  conversation.replaceChildren(...items.map(bubble), ...cards);
  conversation.scrollTop = conversation.scrollHeight;
  renderBudget(items);
}

// Shows how much of the selected model's context window the conversation uses. Where OpenRouter
// has counted the last request, that exact count is used, plus an estimate for what came after.
function renderBudget(items: ChatMessage[]): void {
  const contextLength = contextLengthOf(modelInput.value.trim());
  if (contextLength === undefined) {
    budgetBar.style.width = "0%";
    budgetBar.classList.remove("nearly-full");
    budgetLabel.textContent = "Choose a model to see its context limit.";
    return;
  }
  const limit = conversationLimit(contextLength);
  const anchorAt = measured ? items.indexOf(measured.anchor) : -1;
  let tokens: number;
  let exact = false;
  if (measured !== undefined && anchorAt >= 0) {
    exact = true;
    tokens =
      measured.tokens + budgetUsage(items.slice(anchorAt + 1), limit).tokens;
  } else {
    // Shows the messages a send would actually include, so the meter matches the request.
    tokens = budgetUsage(trimToBudget(items, limit), limit).tokens;
  }
  const ratio = limit > 0 ? tokens / limit : 1;
  budgetBar.style.width = `${String(Math.min(100, ratio * 100))}%`;
  budgetBar.classList.toggle("nearly-full", ratio >= 0.9);
  budgetLabel.textContent = exact
    ? `${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (exact for the last request, estimated since)`
    : `About ${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (estimated)`;
}

// The active model is remembered in this browser only.
function readActiveModel(): string {
  return readStorage(ACTIVE_MODEL_KEY) ?? "";
}

// Sends the user's answer to a proposed change. The reply continues on its own stream.
async function answer(id: string, approved: boolean): Promise<void> {
  if (inFlight) {
    inFlight.approvals = inFlight.approvals.filter((a) => a.id !== id);
  }
  renderConversation();
  const decision: ApprovalDecision = { approved };
  const result = await apiJson(`/api/approvals/${id}`, ApprovalAckSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decision),
  });
  if (!result.ok) {
    chatStatus.textContent = `Unavailable: ${result.error}`;
  }
}

// Reads the server-sent events of one reply. Text and proposed changes are passed on as
// they arrive. Returns the full reply text, or the error that ended it.
async function readReply(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
  onApproval: (approval: PendingApproval) => void,
  onUsage: (promptTokens: number) => void,
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
      } else if (event.value.type === "approval") {
        onApproval(event.value);
      } else if (event.value.type === "usage") {
        onUsage(event.value.promptTokens);
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
  const parsed = parseJson(ChatStreamEventSchema, payload);
  return parsed.ok ? ok(parsed.value) : err(describeParseError(parsed.error));
}

// Sends the conversation with one new message and records the reply when it completes.
async function sendMessage(): Promise<void> {
  const model = modelInput.value.trim();
  const message = chatMessage.value.trim();
  chatStatus.textContent = "";
  const contextLength = contextLengthOf(model);
  if (contextLength === undefined) {
    chatStatus.textContent = "Choose a model from the list.";
    return;
  }
  if (!message) {
    chatStatus.textContent = "Type a message first.";
    return;
  }

  // Older messages are dropped, oldest first, so the conversation fits the model's limit.
  const limit = conversationLimit(contextLength);
  const userMessage: ChatMessage = { role: "user", content: message };
  const full: ChatMessage[] = [...history, userMessage];
  const messages = trimToBudget(full, limit);
  if (!fitsBudget(messages, limit)) {
    chatStatus.textContent = "That message is too long to send.";
    return;
  }
  const dropped = messages.length < full.length;
  inFlight = { userMessage, reply: "", approvals: [] };
  chatMessage.value = "";
  chatSend.disabled = true;
  chatStatus.textContent = "Waiting for reply…";
  renderConversation();
  try {
    const opened = await openChat({ model, messages });
    const outcome = opened.ok
      ? await readReply(
          opened.value,
          (text) => {
            if (inFlight) {
              inFlight.reply += text;
            }
            renderConversation();
          },
          (approval) => {
            if (inFlight) {
              inFlight.approvals.push(approval);
            }
            chatStatus.textContent = "Waiting for your approval…";
            renderConversation();
          },
          (promptTokens) => {
            measured = { tokens: promptTokens, anchor: userMessage };
            renderConversation();
          },
        )
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
  measured = undefined;
  saveHistory();
  chatStatus.textContent = "";
  renderConversation();
}

export function initChat(): void {
  history = loadHistory();
  modelInput.value = readActiveModel();
  modelInput.addEventListener("change", () => {
    writeStorage(ACTIVE_MODEL_KEY, modelInput.value.trim());
    // A count from another model's tokenizer does not apply to this one.
    measured = undefined;
    renderConversation();
  });
  chatSend.addEventListener("click", () => void sendMessage());
  chatNew.addEventListener("click", newConversation);
  renderConversation();
}
