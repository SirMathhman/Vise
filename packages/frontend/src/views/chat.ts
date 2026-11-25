import type {
  ApprovalDecision,
  ChatMessage,
  ChatStreamEvent,
  Result,
} from "common";
import {
  ApprovalAckSchema,
  ChatMessageListSchema,
  NotesResponseSchema,
  OkResponseSchema,
  PROFILE_CATEGORY,
  ChatStreamEventSchema,
  budgetUsage,
  compactConversation,
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
const profileSelect = requireElement("profile-select") as HTMLSelectElement;

// The profile this conversation uses. It resets with New conversation and is not kept across reloads.
let profileId: string | undefined;

// Fills the picker with the notes whose category is the profile category. A failed load keeps the
// current choice.
async function loadProfiles(): Promise<void> {
  const result = await apiJson("/api/notes", NotesResponseSchema);
  if (!result.ok) {
    chatStatus.textContent = `Profiles unavailable: ${result.error}`;
    return;
  }
  const profiles = result.value.notes.filter(
    (note) => note.category === PROFILE_CATEGORY,
  );
  if (profileId !== undefined && !profiles.some((p) => p.id === profileId)) {
    profileId = undefined;
  }
  profileSelect.replaceChildren(
    new Option("No profile", ""),
    ...profiles.map((p) => new Option(p.name, p.id)),
  );
  profileSelect.value = profileId ?? "";
}

// A proposed change that waits for the user's answer.
interface PendingApproval {
  id: string;
  title: string;
  body: string;
}

// The exchange currently streaming in: the user's message, the reply so far, and the changes
// waiting for an answer.
interface InFlight {
  userMessage: ChatMessage;
  reply: string;
  approvals: PendingApproval[];
}

// The exact prompt tokens OpenRouter counted for the last request, and the user message that
// request was made for.
interface Measured {
  tokens: number;
  anchor: ChatMessage;
}

// The tokens a conversation uses, and whether that count is exact.
interface TokenUsage {
  tokens: number;
  exact: boolean;
}

// The conversation so far, and the exchange currently streaming in.
let history: ChatMessage[] = [];
let inFlight: InFlight | undefined;

// The exact prompt tokens OpenRouter counted for the last request, and the user message that
// request was made for. Held for this page only.
let measured: Measured | undefined;

// When a conversation reaches this share of the model's limit, it is summarized before the next
// send. The summary replaces the older messages; the most recent ones are kept as they are.
const COMPACT_AT = 0.8;
const KEEP_RECENT = 10;
const SUMMARY_REQUEST = "Summarize the convo";

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
  approve.addEventListener("click", () => void answer(approval.id, "approve"));
  const reject = document.createElement("button");
  reject.type = "button";
  reject.textContent = "Reject";
  reject.addEventListener("click", () => void answer(approval.id, "reject"));
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

// The tokens a conversation uses. Where OpenRouter has counted the last request, that exact
// count is used, plus an estimate for what came after it.
function usedTokens(items: ChatMessage[], limit: number): TokenUsage {
  const anchorAt = measured ? items.indexOf(measured.anchor) : -1;
  if (measured !== undefined && anchorAt >= 0) {
    return {
      tokens:
        measured.tokens + budgetUsage(items.slice(anchorAt + 1), limit).tokens,
      exact: true,
    };
  }
  return { tokens: budgetUsage(items, limit).tokens, exact: false };
}

// Shows how much of the selected model's context window the conversation uses.
function renderBudget(items: ChatMessage[]): void {
  const contextLength = contextLengthOf(modelInput.value.trim());
  if (contextLength === undefined) {
    budgetBar.style.width = "0%";
    budgetBar.classList.remove("nearly-full");
    budgetLabel.textContent = "Choose a model to see its context limit.";
    return;
  }
  const limit = conversationLimit(contextLength);
  // Shows the messages a send would actually include, so the meter matches the request.
  const whole = usedTokens(items, limit);
  const shown = whole.exact
    ? whole
    : usedTokens(trimToBudget(items, limit), limit);
  const tokens = shown.tokens;
  const exact = shown.exact;
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
async function answer(id: string, choice: "approve" | "reject"): Promise<void> {
  if (inFlight) {
    inFlight.approvals = inFlight.approvals.filter((a) => a.id !== id);
  }
  renderConversation();
  const decision: ApprovalDecision = { approved: choice === "approve" };
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

// Asks the model to summarize the conversation so far. No tools are offered, so the reply is
// text only and cannot read files or propose changes.
async function summarizeConversation(
  model: string,
  limit: number,
): Promise<Result<string, string>> {
  const request = trimToBudget(
    [...history, { role: "user", content: SUMMARY_REQUEST }],
    limit,
  );
  const opened = await openChat({
    model,
    messages: request,
    allowTools: false,
  });
  if (!opened.ok) {
    return err(opened.error);
  }
  return readReply(
    opened.value,
    () => undefined,
    () => undefined,
    () => undefined,
  );
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

  const limit = conversationLimit(contextLength);
  const userMessage: ChatMessage = { role: "user", content: message };

  // Near the limit, the older conversation is summarized first. The summary replaces it, and
  // the most recent messages are kept.
  let compacted = false;
  if (
    usedTokens([...history, userMessage], limit).tokens >=
    COMPACT_AT * limit
  ) {
    chatSend.disabled = true;
    chatStatus.textContent = "Summarizing the conversation…";
    let summary: Result<string, string>;
    try {
      summary = await summarizeConversation(model, limit);
    } catch (failure) {
      summary = err(errorMessage(failure));
    }
    chatSend.disabled = false;
    if (!summary.ok) {
      chatStatus.textContent = `Could not summarize: ${summary.error}`;
      return;
    }
    history = compactConversation(history, summary.value, KEEP_RECENT);
    measured = undefined;
    saveHistory();
    compacted = true;
  }

  // Older messages are dropped, oldest first, so the conversation fits the model's limit.
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
    const opened = await openChat({ model, messages, profileId });
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
      chatStatus.textContent = compacted
        ? "Done. The conversation was summarized to keep room."
        : dropped
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

// Tells the backend the session has ended, so its after-session command can run.
async function endSession(): Promise<void> {
  await apiJson("/api/session/end", OkResponseSchema, { method: "POST" });
}

function newConversation(): void {
  if (history.length > 0) {
    void endSession();
  }
  history = [];
  measured = undefined;
  profileId = undefined;
  profileSelect.value = "";
  saveHistory();
  chatStatus.textContent = "";
  renderConversation();
}

/**
 * Wires the chat panel: restores the saved model and conversation, and connects the controls.
 */
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
  profileSelect.addEventListener("focus", () => void loadProfiles());
  profileSelect.addEventListener("change", () => {
    profileId = profileSelect.value || undefined;
  });
  void loadProfiles();
  renderConversation();
}
