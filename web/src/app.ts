import { createExplorer } from "./explorer.ts";
import { setupComposer } from "./composer.ts";
import { createPanels } from "./panels.ts";
import { renderMarkdown } from "./markdown.ts";
import { createProfileEditor } from "./profile-editor.ts";
import { createTranscript } from "./transcript.ts";

interface ResultMessage {
  ok?: boolean;
  value?: string;
  error?: string;
  context?: string;
  streamed?: boolean;
  compactionWarning?: string;
  /** Echo of the request id, set for editor-side requests only. */
  id?: string;
}

interface ServerMessage extends ResultMessage {
  type: string;
  text?: string;
  name?: string;
  depth?: number;
  active?: boolean;
  tools?: string[] | null;
  question?: string;
  options?: string[];
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}

const log = requiredElement<HTMLElement>("log");
const input = requiredElement<HTMLInputElement>("input");
const commandSuggestions = requiredElement<HTMLUListElement>(
  "command-suggestions",
);
const send = requiredElement<HTMLButtonElement>("send");
const stopBtn = requiredElement<HTMLButtonElement>("stop");
const status = requiredElement<HTMLElement>("status");
const modelSelect = requiredElement<HTMLSelectElement>("model");
const profileSelect = requiredElement<HTMLSelectElement>("profile");
const reasoningSelect = requiredElement<HTMLSelectElement>("reasoning");
const toolsBtn = requiredElement<HTMLButtonElement>("tools-btn");
const newBtn = requiredElement<HTMLButtonElement>("new-btn");
const burstBtn = requiredElement<HTMLButtonElement>("burst-btn");
const toolsPanel = requiredElement<HTMLElement>("tools-panel");
const sessionsBtn = requiredElement<HTMLButtonElement>("sessions-btn");
const sessionsPanel = requiredElement<HTMLElement>("sessions-panel");
const saveName = requiredElement<HTMLInputElement>("save-name");
const saveBtn = requiredElement<HTMLButtonElement>("save-btn");
const filesBtn = requiredElement<HTMLButtonElement>("files-btn");
const workspace = requiredElement<HTMLElement>("workspace");
const explorer = createExplorer(
  requiredElement<HTMLElement>("files-path"),
  requiredElement<HTMLUListElement>("files-list"),
  requiredElement<HTMLElement>("files-tabs"),
  requiredElement<HTMLPreElement>("files-viewer"),
  {
    mdView: requiredElement<HTMLElement>("files-md"),
    frame: requiredElement<HTMLIFrameElement>("files-frame"),
    urlForm: requiredElement<HTMLFormElement>("files-url-form"),
    addrForm: requiredElement<HTMLFormElement>("files-addr-form"),
    modeBtn: requiredElement<HTMLButtonElement>("files-mode"),
    renderMarkdown,
  },
);
const contextEl = requiredElement<HTMLElement>("context");
const ask = requiredElement<HTMLElement>("ask");
const askQuestion = requiredElement<HTMLElement>("ask-question");
const askOptions = requiredElement<HTMLUListElement>("ask-options");
const askAnswer = requiredElement<HTMLInputElement>("ask-answer");
const askSend = requiredElement<HTMLButtonElement>("ask-send");

const transcript = createTranscript(log, renderMarkdown);
const socket = new WebSocket(
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
);

let pendingModelList = false;
let pendingProfileList = false;
let pendingReasoningList = false;
let pendingToolList = false;
let pendingSessionList = false;
let pendingToolToggle: string | null = null;
let pendingBurstSync = false;
// The tools panel refresh is a queued line; its reply is matched by id because
// the connection also carries the model's turns.
const toolRefreshes = new Set<string>();
// Whitelist reads/writes bypass the turn queue (`profile_tools` messages).
const whitelistRequests = new Map<string, { name: string; save: boolean }>();
let nextRequestId = 0;

function requestToolRefresh(): void {
  const id = `ed${nextRequestId++}`;
  toolRefreshes.add(id);
  socket.send(JSON.stringify({ type: "line", text: "/tool", id }));
}

function requestWhitelist(name: string, save: boolean, tools?: string[]): void {
  const id = `ed${nextRequestId++}`;
  whitelistRequests.set(id, { name, save });
  socket.send(
    JSON.stringify({
      type: "profile_tools",
      id,
      name,
      read: !save,
      tools: tools ?? null,
    }),
  );
}

function setStatus(text: string): void {
  status.textContent = text;
}

function setBusy(next: boolean): void {
  if (next) hideSuggestions();
  input.disabled = next;
  send.disabled = next;
  stopBtn.disabled = !next;
  modelSelect.disabled = next;
  profileSelect.disabled = next;
  reasoningSelect.disabled = next;
  toolsBtn.disabled = next;
  burstBtn.disabled = next;
  newBtn.disabled = next;
  sessionsBtn.disabled = next;
}

function sendLine(text: string): void {
  if (!text.trim()) return;
  hideSuggestions();
  setBusy(true);
  transcript.addLine("user", text);
  socket.send(JSON.stringify({ type: "line", text }));
}

function resumeSession(name: string): void {
  sendLine(`/resume ${name}`);
}

function deleteSession(name: string): void {
  sendLine(`/delete ${name}`);
}

const panels = createPanels({ resumeSession, deleteSession });
const profileEditor = createProfileEditor({
  loadWhitelist(name) {
    requestWhitelist(name, false);
  },
  saveWhitelist(name, tools) {
    requestWhitelist(name, true, tools);
  },
  toolNames: () => panels.toolNames(),
  profileNames: () =>
    Array.from(profileSelect.options, (o) => o.value).filter(
      (v) => v !== "" && v !== "default",
    ),
  activeProfile: () => profileSelect.value,
});
function selectValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options)
    .filter((option) => option.value && !option.disabled)
    .map((option) => option.value);
}

const hideSuggestions = setupComposer(
  input,
  commandSuggestions,
  () => ({
    models: selectValues(modelSelect),
    profiles: selectValues(profileSelect),
    sessions: panels.sessions(),
    tools: panels.toolNames(),
  }),
  sendLine,
);

function saveSession(): void {
  const name = saveName.value.trim();
  if (!name) return;
  saveName.value = "";
  sendLine(`/save ${name}`);
}

function submitAsk(): void {
  const answer = askAnswer.value;
  askAnswer.value = "";
  hideAsk();
  socket.send(JSON.stringify({ type: "ask_answer", text: answer }));
}

function showAsk(message: ServerMessage): void {
  askQuestion.textContent = message.question ?? "";
  askOptions.textContent = "";
  (message.options ?? []).forEach((option, index) => {
    const item = document.createElement("li");
    item.textContent = `${index + 1}. ${option}`;
    askOptions.appendChild(item);
  });
  ask.classList.remove("hidden");
  askAnswer.focus();
}

function hideAsk(): void {
  ask.classList.add("hidden");
  askQuestion.textContent = "";
  askOptions.textContent = "";
}

function renderContext(message: ResultMessage): void {
  if (!message.context) return;
  contextEl.textContent = message.context;
  const match = message.context.match(/\(([\d.]+)%\)$/);
  if (match) contextEl.classList.toggle("warning", Number(match[1]) >= 90);
}

function requestLine(text: string): void {
  socket.send(JSON.stringify({ type: "line", text }));
}

function setBurstPressed(on: boolean): void {
  burstBtn.setAttribute("aria-pressed", String(on));
}

function handleToolRefresh(message: ResultMessage): boolean {
  if (message.id === undefined || !toolRefreshes.delete(message.id))
    return false;
  if (message.ok && message.value) panels.populateToolsPanel(message.value);
  return true;
}

function handleWhitelistReply(message: ServerMessage): void {
  const request = message.id ? whitelistRequests.get(message.id) : undefined;
  if (!request || !message.id) return;
  whitelistRequests.delete(message.id);
  if (message.ok) {
    profileEditor.showWhitelist(request.name, message.tools ?? undefined);
    if (request.save) profileEditor.showStatus("saved ✓");
  } else {
    const reason = message.error ?? "unknown error";
    profileEditor.showStatus(`failed: ${reason}`, true);
  }
}

function handleInitialResult(message: ResultMessage): boolean {
  if (pendingBurstSync) {
    // The session may already have burst on (e.g. after a page reload).
    pendingBurstSync = false;
    if (message.ok) setBurstPressed(message.value?.endsWith(" on") ?? false);
    setBusy(false);
    return true;
  }
  if (pendingModelList) {
    pendingModelList = false;
    if (message.ok && message.value) {
      panels.populateModelSelect(message.value);
      setBusy(true);
      requestLine("/profile");
    } else {
      setBusy(false);
      profileSelect.disabled = true;
      transcript.addLine("error", message.error ?? "unknown error");
    }
    return true;
  }
  if (pendingProfileList) {
    pendingProfileList = false;
    if (message.ok && message.value) {
      panels.populateProfileSelect(message.value);
      setBusy(true);
      requestLine("/tool");
    } else {
      pendingToolList = false;
      setBusy(false);
      transcript.addLine("error", message.error ?? "unknown error");
    }
    return true;
  }
  if (pendingToolList) {
    pendingToolList = false;
    if (message.ok && message.value) {
      panels.populateToolsPanel(message.value);
      setBusy(true);
      requestLine("/reasoning");
    } else {
      setBusy(false);
    }
    return true;
  }
  if (pendingReasoningList) {
    pendingReasoningList = false;
    if (message.ok && message.value) {
      panels.populateReasoningSelect(message.value);
      setBusy(true);
      requestLine("/resume");
    } else {
      setBusy(false);
      reasoningSelect.disabled = true;
      transcript.addLine("error", message.error ?? "unknown error");
    }
    return true;
  }
  if (pendingSessionList) {
    pendingSessionList = false;
    if (message.ok && message.value)
      panels.populateSessionsPanel(message.value);
    pendingBurstSync = true;
    requestLine("/burst");
    return true;
  }
  return false;
}

function handleToolToggleResult(message: ResultMessage): boolean {
  if (!pendingToolToggle) return false;
  pendingToolToggle = null;
  if (message.ok) transcript.addLine("system", message.value ?? "");
  else transcript.addLine("error", message.error ?? "unknown error");
  requestLine("/tool");
  pendingToolList = true;
  setBusy(false);
  return true;
}

function handleCommandResult(message: ResultMessage): void {
  if (message.value === "started a new conversation") {
    transcript.clear();
    transcript.addLine("system", message.value);
  } else if (message.value?.startsWith("resumed session ")) {
    transcript.clear();
    transcript.addLine("system", message.value);
  } else if (message.value?.startsWith("saved session ")) {
    transcript.addLine("system", message.value);
    pendingSessionList = true;
    requestLine("/resume");
  } else if (message.value?.startsWith("deleted session ")) {
    transcript.addLine("system", message.value);
    pendingSessionList = true;
    requestLine("/resume");
  } else if (message.value?.startsWith("burst mode ")) {
    const on = message.value.endsWith(" on");
    setBurstPressed(on);
    transcript.addLine("system", `burst: ${on ? "on" : "off"}`);
  } else if (message.value?.startsWith("switched to model ")) {
    modelSelect.value = message.value.slice("switched to model ".length);
    transcript.addLine("system", `model: ${modelSelect.value}`);
  } else if (message.value?.startsWith("profile set to ")) {
    const name = message.value.slice("profile set to ".length);
    panels.removeProfilePlaceholder();
    profileSelect.value = name;
    transcript.addLine("system", `profile: ${name}`);
    requestToolRefresh();
  } else if (message.value?.startsWith("reasoning effort set to ")) {
    const name = message.value.slice("reasoning effort set to ".length);
    const level = name.replace(" (template default)", "");
    if (reasoningSelect.querySelector(`option[value="${level}"]`)) {
      reasoningSelect.value = level;
    }
    transcript.addLine("system", `reasoning: ${level}`);
  } else if (message.value === "profile cleared") {
    panels.addProfilePlaceholder();
    profileSelect.value = "";
    transcript.addLine("system", "profile cleared");
    requestToolRefresh();
  } else if (!message.streamed && message.value) {
    transcript.addLine("assistant", message.value);
  }
  if (message.compactionWarning) {
    transcript.addLine("system", message.compactionWarning);
  }
}

function handleResult(message: ResultMessage): void {
  transcript.flushAssistant();
  burstBtn.classList.remove("bursting");
  transcript.setBurst(false);
  hideAsk();
  renderContext(message);
  if (handleToolRefresh(message)) return;
  if (handleInitialResult(message)) return;
  if (handleToolToggleResult(message)) return;
  setBusy(false);
  if (message.ok) handleCommandResult(message);
  else transcript.addLine("error", message.error ?? "unknown error");
}

send.addEventListener("click", () => {
  sendLine(input.value);
  input.value = "";
});
stopBtn.addEventListener("click", () =>
  socket.send(JSON.stringify({ type: "interrupt" })),
);
modelSelect.addEventListener("change", () => {
  if (!modelSelect.value) return;
  pendingModelList = false;
  sendLine(`/model ${modelSelect.value}`);
});
profileSelect.addEventListener("change", () => {
  if (!profileSelect.value) return;
  pendingProfileList = false;
  sendLine(`/profile ${profileSelect.value}`);
});
reasoningSelect.addEventListener("change", () => {
  if (!reasoningSelect.value) return;
  pendingReasoningList = false;
  sendLine(`/reasoning ${reasoningSelect.value}`);
});
newBtn.addEventListener("click", () => sendLine("/new"));
burstBtn.addEventListener("click", () => {
  const on = burstBtn.getAttribute("aria-pressed") !== "true";
  sendLine(`/burst ${on ? "on" : "off"}`);
});
toolsBtn.addEventListener("click", () => toolsPanel.classList.toggle("hidden"));
filesBtn.addEventListener("click", () => {
  workspace.classList.toggle("hidden");
  if (!workspace.classList.contains("hidden")) void explorer.open("");
});
sessionsBtn.addEventListener("click", () => {
  sessionsPanel.classList.toggle("hidden");
  // Turns auto-save in the background, so refresh the list when it opens.
  if (!sessionsPanel.classList.contains("hidden")) {
    pendingSessionList = true;
    setBusy(true);
    requestLine("/resume");
  }
});
saveBtn.addEventListener("click", saveSession);
saveName.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveSession();
  }
});
requiredElement<HTMLUListElement>("tools-list").addEventListener(
  "change",
  (event) => {
    const checkbox = event.target;
    if (!(checkbox instanceof HTMLInputElement) || !checkbox.value) return;
    const verb = checkbox.checked ? "enable" : "disable";
    checkbox.closest("li")?.classList.toggle("disabled", !checkbox.checked);
    pendingToolToggle = checkbox.value;
    sendLine(`/tool ${checkbox.value} ${verb}`);
  },
);
askSend.addEventListener("click", submitAsk);
askAnswer.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitAsk();
  }
});

socket.addEventListener("open", () => {
  setStatus("connected");
  transcript.addLine("system", "Connected. Type a message to begin.");
  pendingModelList = true;
  pendingProfileList = true;
  pendingToolList = true;
  pendingSessionList = true;
  pendingReasoningList = true;
  setBusy(true);
  requestLine("/model");
});
socket.addEventListener("close", () => {
  setStatus("disconnected");
  transcript.flushAssistant();
  setBusy(false);
});
socket.addEventListener("message", (event: MessageEvent<string>) => {
  let message: ServerMessage;
  try {
    message = JSON.parse(event.data) as ServerMessage;
  } catch {
    return;
  }
  switch (message.type) {
    case "profile_tools":
      handleWhitelistReply(message);
      break;
    case "fs_changed":
      void explorer.reload();
      break;
    case "subagent_token":
      transcript.appendSubagentToken(message.text ?? "");
      break;
    case "token":
      transcript.appendAssistantToken(message.text ?? "");
      break;
    case "thinking":
      transcript.appendThinkingToken(message.text ?? "");
      break;
    case "tool":
      transcript.appendToolCall(message.name ?? "unknown", message.depth);
      break;
    case "burst":
      burstBtn.classList.toggle("bursting", !!message.active);
      transcript.setBurst(!!message.active);
      break;
    case "progress":
      break;
    case "result":
      transcript.finishThinking();
      handleResult(message);
      break;
    case "ask":
      showAsk(message);
      break;
    case "exit":
      transcript.finishThinking();
      transcript.addLine("system", "Session ended.");
      setBusy(false);
      break;
  }
});
