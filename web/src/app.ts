import { createAttachments } from "./composer/attachments.ts";
import { createHooksPanel } from "./settings/hooks-panel.ts";
import type { ResultMessage, ServerMessage } from "./server-message.ts";
import { replayHistory, showImage } from "./log/history.ts";
import { appendPicture } from "./log/lightbox.ts";
import { createGoalUi } from "./status/goal-ui.ts";
import { createAskUi } from "./composer/ask-ui.ts";
import { createCompactionMarker } from "./status/compaction-ui.ts";
import { createGenerating } from "./status/generating.ts";
import { createPromptProgress } from "./status/prompt-progress.ts";
import { createBusy } from "./composer/busy.ts";
import { createSteerUi } from "./composer/steer-ui.ts";
import { bindToolToggles } from "./settings/tool-toggles.ts";
import { createSettingsPanels } from "./settings/settings-panels.ts";
import { createWorkspace } from "./workspace/workspace.ts";
import { setupComposer } from "./composer/composer.ts";
import { createPanels } from "./settings/panels.ts";
import { registerHeaderPanels } from "./status/panel-switch.ts";
import { createProfileEditor } from "./settings/profile-editor.ts";
import { createLogView } from "./log/log-view.ts";
import { renderMarkdown } from "./markdown.ts";

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

const { transcript, announce } = createLogView(
  log,
  requiredElement("jump-latest"),
  requiredElement("sr-status"),
);
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
const askUi = createAskUi(
  {
    box: requiredElement("ask"),
    question: requiredElement("ask-question"),
    options: requiredElement("ask-options"),
    answer: requiredElement("ask-answer"),
    send: requiredElement("ask-send"),
    composer: input,
  },
  sendMessage,
  announce,
);
const hooksPanel = createHooksPanel(
  requiredElement<HTMLElement>("hooks-body"),
  sendMessage,
  (hooks) => profileEditor.showHooks(hooks),
);
const settingsPanels = createSettingsPanels(sendMessage);
const workspace = createWorkspace(sendMessage, renderMarkdown, setStatus);
/** The parts of the page that own some of the server messages. */
const goalUi = createGoalUi(
  transcript.addLine,
  transcript.addCollapsed,
  sendMessage,
);
const promptProgress = createPromptProgress(
  transcript.addLine,
  transcript.removeLine,
);
const generating = createGenerating(transcript.addLine, transcript.removeLine);
const compactionMarker = createCompactionMarker(transcript.addLine);
const steerUi = createSteerUi({
  sendMessage,
  notice: (text) => transcript.addLine("system", text),
  list: requiredElement("queue"),
  steerBtn: requiredElement("steer-btn"),
  queueBtn: requiredElement("queue-btn"),
});
const serverPanels = [hooksPanel, settingsPanels, workspace, goalUi, steerUi];

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

const busyUi = createBusy({
  input,
  send,
  stop: stopBtn,
  locked: [modelSelect, profileSelect, reasoningSelect, burstBtn, newBtn],
  setSteering: (on) => steerUi.setRunning(on),
  hideSuggestions: () => hideSuggestions(),
});
const {
  state: busy,
  isBusy,
  render: renderBusy,
  endLoading,
  reset: resetBusy,
} = busyUi;

/**
 * Send a line. While a turn runs, plain words steer it (reach the agent before
 * its next step) unless `queue` asks to wait until the task is done; commands
 * always wait.
 */
function sendLine(text: string, queue = false): void {
  const running = steerUi.running;
  const images = attachments.take();
  // A picture alone is a message too.
  const body =
    text.trim() || (images.length > 0 ? "(see the attached image)" : "");
  if (!body) return;
  hideSuggestions();
  const show = (cls = "user"): void => {
    transcript.addLine(cls, body);
    for (const image of images)
      appendPicture(transcript, image.uri, image.label);
  };
  // Commands about the queue itself act at once, whatever is running.
  if (/^\/(steer|queue)(\s|$)/.test(body)) {
    socket.send(JSON.stringify({ type: "line", text: body }));
    return;
  }
  if (running && (queue || body.startsWith("/"))) {
    steerUi.hold(body, images, show);
    return;
  }
  if (running) {
    show("user steer");
    steerUi.steer(body, images);
    return;
  }
  busy.submitting = true;
  renderBusy();
  show();
  socket.send(JSON.stringify({ type: "line", text: body, images }));
}

const panels = createPanels({
  resumeSession: (name) => sendLine(`/resume ${name}`),
  deleteSession: (name) => sendLine(`/delete ${name}`),
});
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

function renderContext(message: ResultMessage): void {
  if (message.context) showContext("reply", message.context);
}

/** A model call's context fill: the header's for the main conversation, the open box's for a subagent. */
function showContext(purpose: string | undefined, text: string): void {
  if (purpose === "subagent") return transcript.setBoxMeta(text);
  contextEl.textContent = text;
  const match = text.match(/\(([\d.]+)%\)$/);
  if (match) contextEl.classList.toggle("warning", Number(match[1]) >= 90);
}

function requestLine(text: string): void {
  socket.send(JSON.stringify({ type: "line", text }));
}

const setBurstPressed = (on: boolean): void =>
  burstBtn.setAttribute("aria-pressed", String(on));

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
    endLoading();
    return true;
  }
  if (pendingModelList) {
    pendingModelList = false;
    if (message.ok && message.value) {
      panels.populateModelSelect(message.value);
      requestLine("/profile");
    } else {
      endLoading();
      profileSelect.disabled = true;
      transcript.addLine("error", message.error ?? "unknown error");
    }
    return true;
  }
  if (pendingProfileList) {
    pendingProfileList = false;
    if (message.ok && message.value) {
      panels.populateProfileSelect(message.value);
      requestLine("/tool");
    } else {
      pendingToolList = false;
      endLoading();
      transcript.addLine("error", message.error ?? "unknown error");
    }
    return true;
  }
  if (pendingToolList) {
    pendingToolList = false;
    if (message.ok && message.value) {
      panels.populateToolsPanel(message.value);
      requestLine("/reasoning");
    } else {
      endLoading();
    }
    return true;
  }
  if (pendingReasoningList) {
    pendingReasoningList = false;
    if (message.ok && message.value) {
      panels.populateReasoningSelect(message.value);
      requestLine("/resume");
    } else {
      endLoading();
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
  else if (!isBusy()) transcript.addLine("system", message.value ?? "");
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
  transcript.endBoxes(); // a turn that ended mid-subagent leaves no box open
  // Answers to side requests leave the turn in flight (its stream, prompt and busy state) alone.
  if (handleToolRefresh(message) || handleToolToggleResult(message)) return;
  transcript.flushAssistant();
  burstBtn.classList.remove("bursting");
  transcript.setBurst(false);
  askUi.hide();
  // The log itself is not a live region (every token would be announced); say only that the reply ended.
  announce(message.ok ? "Reply finished" : "Reply failed");
  renderContext(message);
  if (handleInitialResult(message)) return;
  if (message.ok) handleCommandResult(message);
  else transcript.addLine("error", message.error ?? "unknown error");
}

send.addEventListener("click", () => {
  sendLine(input.value);
  input.value = "";
});
requiredElement("steer-btn").addEventListener("click", () => {
  sendLine(input.value);
  input.value = "";
});
requiredElement("queue-btn").addEventListener("click", () => {
  sendLine(input.value, true);
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
    if (isBusy()) return;
    pendingSessionList = true;
    busy.loading = true;
    renderBusy();
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
bindToolToggles(requiredElement("tools-list"), (line) =>
  requestTracked(line, toolToggles),
);

socket.addEventListener("open", () => {
  setStatus("connected");
  transcript.addLine("system", "Connected. Type a message to begin.");
  pendingModelList = true;
  pendingProfileList = true;
  pendingToolList = true;
  pendingSessionList = true;
  pendingReasoningList = true;
  busy.loading = true;
  renderBusy();
  requestLine("/model");
});
socket.addEventListener("close", () => {
  setStatus("disconnected");
  askUi.hide(); // an answer would go nowhere
  transcript.flushAssistant();
  resetBusy();
});
socket.addEventListener("message", (event: MessageEvent<string>) => {
  let message: ServerMessage;
  try {
    message = JSON.parse(event.data) as ServerMessage;
  } catch {
    return;
  }
  generating.observe(message);
  compactionMarker.observe(message);
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
    case "history":
      replayHistory(transcript, message);
      break;
    case "image":
      showImage(transcript, message);
      break;
    case "tool":
      // A subagent's work goes in a box opened by its line (nested in the box of the subagent that started it).
      if (message.name === "run_subagent")
        transcript.beginBox(message.text ?? "Run helper agent");
      else
        transcript.appendToolCall(
          message.name ?? "unknown",
          undefined,
          message.text,
        );
      break;
    case "tool_result":
      if (message.name === "run_subagent") transcript.endBox();
      else if (message.text) transcript.appendToolResult(message.text);
      break;
    case "burst":
      burstBtn.classList.toggle("bursting", !!message.active);
      transcript.setBurst(!!message.active);
      break;
    case "state":
      Object.assign(busy, {
        server: message.running === true,
        steerable: message.steerable === true,
        submitting: false,
      });
      renderBusy();
      break;
    case "context":
      showContext(message.purpose, message.text ?? "");
      break;
    case "progress":
      promptProgress.handle(message);
      break;
    case "result":
      transcript.finishThinking();
      handleResult(message);
      break;
    case "ask":
      askUi.show(message);
      break;
    case "exit":
      transcript.finishThinking();
      transcript.addLine("system", "Session ended.");
      resetBusy();
      break;
  }
});
