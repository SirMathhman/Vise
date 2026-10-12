import "../styles/index.css";
import { createAttachments } from "./composer/attachments.ts";
import { createHooksPanel } from "./settings/hooks/hooks-panel.ts";
import type { ResultMessage, ServerMessage } from "./server-message.ts";
import { replayHistory, showImage } from "./log/history.ts";
import { appendPicture } from "./log/lightbox.ts";
import { createGoalUi } from "./status/goal-ui.ts";
import { createTodoUi } from "./status/todo-ui.ts";
import { createAskUi } from "./composer/ask-ui.ts";
import { createCompactionMarker } from "./status/compaction-ui.ts";
import { createGenerating } from "./status/generating.ts";
import { createPromptProgress } from "./status/prompt-progress.ts";
import { createBusy } from "./composer/busy.ts";
import { createSteerUi } from "./composer/steer-ui.ts";
import { bindToolToggles, filterToolList } from "./settings/tool-toggles.ts";
import { createSettingsPanels } from "./settings/settings-panels.ts";
import { createWorkspace } from "./workspace/workspace.ts";
import { createTerminalPanel } from "./terminal/terminal-panel.ts";
import { clearComposer, setupComposer } from "./composer/composer.ts";
import { createPanels } from "./settings/panels.ts";
import { createPanelGroup, isNoFolder, registerPages } from "./status/panel-switch.ts";
import { createModelPicker } from "./models/model-picker.ts";
import { createProfileEditor } from "./settings/profiles/profile-editor.ts";
import { createLogView } from "./log/log-view.ts";
import { renderMarkdown } from "./markdown.ts";
import { createConnection } from "./connection.ts";
import { toast } from "./feedback/toast.ts";
import { createGitPanel } from "./git/git-panel.ts";
import { createMenubar } from "./menubar/menubar.ts";
import { appMenus } from "./menubar/app-menus.ts";
import { createWorkflowPicker } from "./menubar/workflow-picker.ts";
import { bindShortcuts, showShortcuts } from "./menubar/shortcuts.ts";
import { openNoFolder, pickFolder } from "./workspace/session-root.ts";
import { createInitialLoad } from "./initial-load.ts";
import { showContextFill } from "./status/context-meter.ts";
import { createToolDetails } from "./log/tool-details.ts";
import { createCallInspector } from "./log/call-inspector.ts";

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}

const input = requiredElement<HTMLTextAreaElement>("input");
const send = requiredElement<HTMLButtonElement>("send");
const stopBtn = requiredElement<HTMLButtonElement>("stop");
const status = requiredElement<HTMLElement>("status");
const modelBtn = requiredElement<HTMLButtonElement>("model-btn");
const profileSelect = requiredElement<HTMLSelectElement>("profile");
const reasoningSelect = requiredElement<HTMLSelectElement>("reasoning");
const burstBadge = requiredElement<HTMLElement>("burst-badge");
const saveName = requiredElement<HTMLInputElement>("save-name");
const sidebar = new URLSearchParams(location.search).get("ui") === "sidebar";

const { transcript, announce } = createLogView(
  requiredElement("log"),
  requiredElement("jump-latest"),
  requiredElement("sr-status"),
);
const attachments = createAttachments({
  input,
  dropZone: requiredElement("log").closest("main") ?? document.body,
  list: requiredElement("attachments"),
  button: requiredElement("attach"),
  picker: requiredElement("attach-picker"),
  say: (message) => toast(message, "error"),
});
const connection = createConnection({
  onOpen,
  onClose,
  onMessage,
});
const sendMessage = connection.send;
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
const settingsPanels = createSettingsPanels(sendMessage, () => isBusy());
const showError = (text: string): void => toast(text, "error");
const workspace = createWorkspace(sendMessage, renderMarkdown, showError);
const terminalPanel = createTerminalPanel(sendMessage, showError);
const goalUi = createGoalUi(transcript.addLine, transcript.addCollapsed, sendMessage);
const promptProgress = createPromptProgress(transcript.addLine, transcript.removeLine);
const generating = createGenerating(transcript.addLine, transcript.removeLine);
const compactionMarker = createCompactionMarker(transcript.addLine);
const composerHint = requiredElement("composer-hint");
const steerUi = createSteerUi({
  sendMessage,
  notice: (text) => transcript.addLine("system", text),
  list: requiredElement("queue"),
  steerBtn: requiredElement("steer-btn"),
  queueBtn: requiredElement("queue-btn"),
});
const todoUi = createTodoUi(requiredElement("todos"));
const gitPanel = createGitPanel(requiredElement("git-panel"), sendMessage, (path) =>
  workspace.openFile(path),
);
const interrupt = (): void => sendMessage({ type: "interrupt" });
const toolDetails = createToolDetails();
const inspector = createCallInspector(sendMessage, interrupt);
// The pulsing "Writing…" line is the way in to what the model is writing.
requiredElement("log").addEventListener("click", (event) => {
  if ((event.target as Element).closest(".line.generating")) inspector.open();
});
const workflowPicker = createWorkflowPicker(
  sendMessage,
  (line) => sendLine(line),
  requiredElement("workflow-run"),
  interrupt,
  transcript.addLine,
  (name) => {
    if ([...profileSelect.options].some((option) => option.value === name)) profileSelect.value = name;
  },
);

/** Connection and work state, in the top bar's pill. */
function setStatus(state: "connecting" | "connected" | "working" | "disconnected", text: string): void {
  status.dataset["state"] = state;
  status.textContent = text;
}

let burstOn = false;
const setBurstPressed = (on: boolean): void => {
  burstOn = on;
  burstBadge.classList.toggle("hidden", !on);
};

const busyUi = createBusy({
  input,
  send,
  stop: stopBtn,
  locked: [profileSelect, reasoningSelect, modelBtn],
  setSteering: (on) => {
    steerUi.setRunning(on);
    composerHint.classList.toggle("hidden", !on);
  },
  hideSuggestions: () => hideSuggestions(),
  onRunning: (running) => {
    if (!connection.isOpen()) return;
    setStatus(running ? "working" : "connected", running ? "Working…" : "Ready");
    if (!running) {
      workflowPicker.running(null);
      if (git.isOpen()) gitPanel.refresh(); // the agent may have changed files
    }
  },
});
const { state: busy, isBusy, render: renderBusy, reset: resetBusy } = busyUi;

/**
 * Send a line. While a turn runs, plain words steer it (reach the agent before
 * its next step) unless `queue` asks to wait until the task is done; commands
 * always wait.
 */
function sendLine(text: string, queue = false): void {
  const running = steerUi.running;
  const images = attachments.take();
  // A picture alone is a message too.
  const body = text.trim() || (images.length > 0 ? "(see the attached image)" : "");
  if (!body) return;
  hideSuggestions();
  const show = (cls = "user"): void => {
    transcript.addLine(cls, body);
    for (const image of images) appendPicture(transcript, image.uri, image.label);
  };
  // Commands about the queue itself act at once, whatever is running.
  if (/^\/(steer|queue)(\s|$)/.test(body)) {
    sendMessage({ type: "line", text: body });
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
  workflowPicker.running(body);
  sendMessage({ type: "line", text: body, images });
}

const panels = createPanels({
  resumeSession: (id) => {
    pages.close();
    sendLine(`/resume ${id}`);
  },
  deleteSession: (id) => sendLine(`/delete ${id}`),
});
const load = createInitialLoad({
  send: sendMessage,
  panels,
  transcript,
  busy: busyUi,
  setBurstPressed,
  profileSelect,
  reasoningSelect,
  onSessions: () => menubar.refresh(),
  setActiveModel: (id) => modelPicker.setActive(id),
});
const profileEditor = createProfileEditor({
  send: sendMessage,
  loadHooks: () => hooksPanel.refresh(),
  editHook: (line) => hooksPanel.edit(line),
  loadWhitelist: (name) => load.requestWhitelist(name, false),
  saveWhitelist: (name, tools) => load.requestWhitelist(name, true, tools),
  toolNames: () => panels.toolNames(),
  toolCategory: (name) => panels.toolCategory(name),
  activeProfile: () => profileSelect.value,
  profilesChanged: (names) => panels.syncProfileOptions(names),
});
load.setProfileEditor(profileEditor);

const hideSuggestions = setupComposer(
  input,
  requiredElement<HTMLUListElement>("command-suggestions"),
  () => ({
    models: modelPicker.modelIds(),
    profiles: load.selectValues(profileSelect),
    sessions: panels.sessions(),
    tools: panels.toolNames(),
  }),
  sendLine,
);

/** The parts of the page that own some of the server messages. */
const serverPanels = [
  hooksPanel,
  profileEditor,
  gitPanel,
  settingsPanels,
  terminalPanel, // before the workspace: both read the `root` message
  workspace,
  goalUi,
  steerUi,
  todoUi,
];

function saveSession(): void {
  const name = saveName.value.trim();
  if (!name) return;
  saveName.value = "";
  sendLine(`/save ${name}`);
}

function sendFromComposer(queue = false): void {
  sendLine(input.value, queue);
  clearComposer(input);
}
send.addEventListener("click", () => sendFromComposer());
requiredElement("steer-btn").addEventListener("click", () => sendFromComposer());
requiredElement("queue-btn").addEventListener("click", () => sendFromComposer(true));
stopBtn.addEventListener("click", interrupt);
profileSelect.addEventListener("change", () => {
  if (profileSelect.value) sendLine(`/profile ${profileSelect.value}`);
});
reasoningSelect.addEventListener("change", () => {
  if (reasoningSelect.value) sendLine(`/reasoning ${reasoningSelect.value}`);
});
requiredElement("compact-btn").addEventListener("click", () => sendLine("/compact"));
requiredElement("context").addEventListener("click", () => sendLine("/context"));

// The top bar: menus and dropdowns share one group (at most one open), pages replace the chat.
const group = createPanelGroup();
const toolsFilter = requiredElement<HTMLInputElement>("tools-filter");
const toolsList = requiredElement<HTMLUListElement>("tools-list");
const tools = group.register({
  panel: requiredElement("tools-panel"),
  onOpen: () => {
    toolsFilter.value = "";
    filterToolList(toolsList, "");
    toolsFilter.focus();
  },
});
toolsFilter.addEventListener("input", () => filterToolList(toolsList, toolsFilter.value));
const git = group.register({ panel: requiredElement("git-panel"), onOpen: gitPanel.refresh });
const modelPanel = group.register({ button: modelBtn, panel: requiredElement("model-panel"), onOpen: () => modelPicker.refresh() });
const modelPicker = createModelPicker({
  button: modelBtn,
  panel: requiredElement("model-panel"),
  search: requiredElement<HTMLInputElement>("model-search"),
  recent: requiredElement("model-recent"),
  recentList: requiredElement<HTMLUListElement>("model-recent-list"),
  list: requiredElement<HTMLUListElement>("model-list"),
  send: sendMessage,
  close: modelPanel.close,
  onChoose: (id) => transcript.addLine("system", `Model: ${id}`),
  onError: (text) => toast(text, "error"),
});
const pages = registerPages(
  {
    settings: () => {
      profileEditor.refresh();
      hooksPanel.refresh();
    },
    // Turns auto-save in the background, so refresh the list when it opens.
    // While a turn runs the list is left as it was (the refresh would queue behind the turn).
    sessions: () => {
      if (!isBusy()) load.refreshSessions();
    },
  },
  group,
);
const sessionTrigger = requiredElement<HTMLButtonElement>("menu-session");
const menubar = createMenubar(
  appMenus(
    {
      isBusy,
      noFolder: isNoFolder,
      sidebar,
      sendLine,
      sessions: () => panels.sessions(),
      pages,
      pickFolder: () => void pickFolder(),
      openNoFolder,
      saveAs: () => {
        pages.open("sessions");
        saveName.focus();
      },
      files: { isOn: workspace.isOpen, toggle: workspace.toggle },
      terminal: { isOn: terminalPanel.isOpen, toggle: terminalPanel.toggle },
      goal: goalUi,
      burst: { isOn: () => burstOn, toggle: () => sendLine(`/burst ${burstOn ? "off" : "on"}`) },
      reasoning: reasoningSelect,
      tools,
      git,
      runWorkflow: workflowPicker.open,
      inspect: () => inspector.open(),
      showShortcuts,
    },
    {
      session: sessionTrigger,
      view: requiredElement("menu-view"),
      agent: requiredElement("menu-agent"),
    },
  ),
  group,
);
requiredElement("root-label").addEventListener("click", () => sessionTrigger.click());
burstBadge.addEventListener("click", () => requiredElement<HTMLButtonElement>("menu-agent").click());
bindShortcuts({
  toggleFiles: () => {
    if (!isNoFolder() && !sidebar) workspace.toggle();
  },
  openSettings: () => pages.toggle("settings"),
  stop: () => {
    if (!busy.server) return false;
    interrupt();
    return true;
  },
  focusComposer: () => input.focus(),
  overlayOpen: () => group.anyOpen() || pages.isOpen() || !!document.querySelector("dialog[open]"),
});
requiredElement("save-btn").addEventListener("click", saveSession);
saveName.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveSession();
  }
});
bindToolToggles(toolsList, (line) => load.toggleTool(line));

function handleResult(message: ResultMessage): void {
  transcript.endBoxes(); // a turn that ended mid-subagent leaves no box open
  // Answers to side requests leave the turn in flight (its stream, prompt and busy state) alone.
  if (load.handleSideResult(message)) return;
  transcript.flushAssistant();
  burstBadge.classList.remove("bursting");
  transcript.setBurst(false);
  askUi.hide();
  // The log itself is not a live region (every token would be announced); say only that the reply ended.
  announce(message.ok ? "Reply finished" : "Reply failed");
  if (message.context) showContext("reply", message.context);
  if (load.handleInitialResult(message)) return;
  if (message.ok) load.handleCommandResult(message, workspace.sync);
  else transcript.addLine("error", message.error ?? "unknown error");
}

/** A model call's context fill: the bar's for the main conversation, the open box's for a subagent. */
function showContext(purpose: string | undefined, text: string): void {
  if (purpose === "subagent") return transcript.setBoxMeta(text);
  showContextFill(text);
}

function onOpen(): void {
  setStatus("connected", "Ready");
  transcript.addLine("system", "Connected. Type a message to begin.");
  load.start();
}

function onClose(retryInMs: number): void {
  setStatus("disconnected", `Disconnected — retrying in ${Math.round(retryInMs / 1000)} s`);
  askUi.hide(); // an answer would go nowhere
  transcript.flushAssistant();
  resetBusy();
}

function onMessage(data: string): void {
  let message: ServerMessage;
  try {
    message = JSON.parse(data) as ServerMessage;
  } catch {
    return;
  }
  generating.observe(message);
  compactionMarker.observe(message);
  workflowPicker.observe(message);
  if (inspector.handle(message)) return;
  if (modelPicker.handle(message)) return;
  if (serverPanels.some((panel) => panel.handle(message))) return;
  switch (message.type) {
    case "profile_tools":
      load.handleWhitelistReply(message);
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
      if (message.name === "run_subagent") transcript.beginBox(message.text ?? "Run helper agent");
      else {
        const line = transcript.appendToolCall(message.name ?? "unknown", undefined, message.text);
        toolDetails.attach(line, message.detail);
      }
      break;
    case "tool_result":
      if (message.name === "run_subagent") transcript.endBox();
      else {
        if (message.text) transcript.appendToolResult(message.text);
        toolDetails.result(message.detail);
      }
      break;
    case "burst":
      burstBadge.classList.toggle("bursting", !!message.active);
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
}
