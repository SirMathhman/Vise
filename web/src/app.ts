import { createAttachments } from "./attachments.ts";
import { createHooksPanel } from "./hooks-panel.ts";
import type { ResultMessage, ServerMessage } from "./server-message.ts";
import { appendPicture } from "./lightbox.ts";
import { createGoalUi } from "./goal-ui.ts";
import { createSettingsPanels } from "./settings-panels.ts";
import { createWorkspace } from "./workspace.ts";
import { setupComposer } from "./composer.ts";
import { createPanels } from "./panels.ts";
import { renderMarkdown } from "./markdown.ts";
import { registerHeaderPanels } from "./panel-switch.ts";
import { createProfileEditor } from "./profile-editor.ts";
import { createTranscript } from "./transcript.ts";

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
const newBtn = requiredElement<HTMLButtonElement>("new-btn");
const burstBtn = requiredElement<HTMLButtonElement>("burst-btn");
const saveName = requiredElement<HTMLInputElement>("save-name");
const saveBtn = requiredElement<HTMLButtonElement>("save-btn");
const filesBtn = requiredElement<HTMLButtonElement>("files-btn");
const contextEl = requiredElement<HTMLElement>("context");
const ask = requiredElement<HTMLElement>("ask");
const askQuestion = requiredElement<HTMLElement>("ask-question");
const askOptions = requiredElement<HTMLUListElement>("ask-options");
const askAnswer = requiredElement<HTMLInputElement>("ask-answer");
const askSend = requiredElement<HTMLButtonElement>("ask-send");

const transcript = createTranscript(log, renderMarkdown);
const attachments = createAttachments({
  input: requiredElement("input"),
  dropZone: requiredElement("log").closest("main") ?? document.body,
  list: requiredElement("attachments"),
  button: requiredElement("attach"),
  picker: requiredElement("attach-picker"),
  say: (message) => transcript.addLine("error", message),
});
const socket = new WebSocket(
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${location.search}`,
);
const sendMessage = (msg: Record<string, unknown>): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
};
const hooksPanel = createHooksPanel(
  requiredElement<HTMLElement>("hooks-body"),
  sendMessage,
  (hooks) => profileEditor.showHooks(hooks),
);
const settingsPanels = createSettingsPanels(sendMessage);
const workspace = createWorkspace(sendMessage, renderMarkdown, setStatus);
/** The parts of the page that own some of the server messages. */
const goalUi = createGoalUi(transcript.addLine, sendMessage);
const serverPanels = [hooksPanel, settingsPanels, workspace, goalUi];

let pendingModelList = false;
let pendingProfileList = false;
let pendingReasoningList = false;
let pendingToolList = false;
let pendingSessionList = false;
let pendingBurstSync = false;
// The tools panel refresh is a queued line; its reply is matched by id because
// the connection also carries the model's turns.
const toolRefreshes = new Set<string>();
// Tool toggles are lines too, matched by id: one made while a turn runs answers after the turn,
// and must be neither taken for the turn's result nor change the busy state.
const toolToggles = new Set<string>();
// Whitelist reads/writes bypass the turn queue (`profile_tools` messages).
const whitelistRequests = new Map<string, { name: string; save: boolean }>();
let nextRequestId = 0;

/** Send a line whose reply is matched by id (it may arrive after a running turn's). */
function requestTracked(text: string, ids: Set<string>): void {
  const id = `ed${nextRequestId++}`;
  ids.add(id);
  socket.send(JSON.stringify({ type: "line", text, id }));
}

const requestToolRefresh = (): void => requestTracked("/tool", toolRefreshes);

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
  burstBtn.disabled = next;
  newBtn.disabled = next;
}

function sendLine(text: string): void {
  const images = attachments.take();
  // A picture alone is a message too.
  const body =
    text.trim() || (images.length > 0 ? "(see the attached image)" : "");
  if (!body) return;
  hideSuggestions();
  setBusy(true);
  transcript.addLine("user", body);
  for (const image of images) appendPicture(transcript, image.uri, image.label);
  socket.send(JSON.stringify({ type: "line", text: body, images }));
}

function resumeSession(name: string): void {
  sendLine(`/resume ${name}`);
}

function deleteSession(name: string): void {
  sendLine(`/delete ${name}`);
}

const panels = createPanels({ resumeSession, deleteSession });
const profileEditor = createProfileEditor({
  loadHooks: () => hooksPanel.refresh(),
  editHook: (line) => hooksPanel.edit(line),
  loadWhitelist(name) {
    requestWhitelist(name, false);
  },
  saveWhitelist(name, tools) {
    requestWhitelist(name, true, tools);
  },
  toolNames: () => panels.toolNames(),
  toolCategory: (name) => panels.toolCategory(name),
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
  if (message.id === undefined || !toolToggles.delete(message.id)) return false;
  if (!message.ok)
    transcript.addLine("error", message.error ?? "unknown error");
  else if (!input.disabled) transcript.addLine("system", message.value ?? "");
  requestToolRefresh();
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
    workspace.sync();
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
  // Answers to side requests leave the turn in flight (its stream, prompt and busy state) alone.
  if (handleToolRefresh(message) || handleToolToggleResult(message)) return;
  transcript.flushAssistant();
  burstBtn.classList.remove("bursting");
  transcript.setBurst(false);
  hideAsk();
  renderContext(message);
  if (handleInitialResult(message)) return;
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
// Header dropdown panels: at most one open; each says what to refresh on open.
registerHeaderPanels({
  settings: () => {
    profileEditor.refresh();
    hooksPanel.refresh();
  },
  // Turns auto-save in the background, so refresh the list when it opens.
  // While a turn runs the list is left as it was (the refresh would queue behind the turn).
  sessions: () => {
    if (input.disabled) return;
    pendingSessionList = true;
    setBusy(true);
    requestLine("/resume");
  },
});
filesBtn.addEventListener("click", () => workspace.toggle());
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
    const row = checkbox.closest("li");
    if (row?.classList.contains("tool-category")) {
      // Show the whole group switching at once; the refreshed list then
      // corrects anything the server kept (opt-in tools stay off).
      checkbox.indeterminate = false;
      for (let r = row.nextElementSibling; r; r = r.nextElementSibling) {
        if (r.classList.contains("tool-category")) break;
        const box = r.querySelector<HTMLInputElement>("input");
        if (box) box.checked = checkbox.checked;
        r.classList.toggle("disabled", !checkbox.checked);
      }
    } else {
      row?.classList.toggle("disabled", !checkbox.checked);
    }
    requestTracked(`/tool ${checkbox.value} ${verb}`, toolToggles);
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
  if (serverPanels.some((panel) => panel.handle(message))) return;
  switch (message.type) {
    case "profile_tools":
      handleWhitelistReply(message);
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
    case "image":
      appendPicture(
        transcript,
        `/api/image/${message.id}`,
        message.label ?? "image",
      );
      break;
    case "tool":
      transcript.appendToolCall(
        message.name ?? "unknown",
        message.depth,
        message.text,
      );
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
