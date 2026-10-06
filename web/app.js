/**
 * Web frontend client. Connects to the Vise web server over a WebSocket and
 * renders the conversation. It is the browser half of the driver seam: the
 * server streams `token`/`thinking`/`tool`/`result` messages and this file
 * turns them into DOM. No build step — plain ES modules. Reply text is shown
 * as plain text for the scaffold; markdown styling is a future extension.
 */

const log = document.getElementById("log");
const input = document.getElementById("input");
const send = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const status = document.getElementById("status");
const modelSelect = document.getElementById("model");
const profileSelect = document.getElementById("profile");
const reasoningSelect = document.getElementById("reasoning");
const toolsBtn = document.getElementById("tools-btn");
const toolsPanel = document.getElementById("tools-panel");
const toolsList = document.getElementById("tools-list");
const sessionsBtn = document.getElementById("sessions-btn");
const sessionsPanel = document.getElementById("sessions-panel");
const sessionsList = document.getElementById("sessions-list");
const saveName = document.getElementById("save-name");
const saveBtn = document.getElementById("save-btn");
const contextEl = document.getElementById("context");

const ask = document.getElementById("ask");
const askQuestion = document.getElementById("ask-question");
const askOptions = document.getElementById("ask-options");
const askAnswer = document.getElementById("ask-answer");
const askSend = document.getElementById("ask-send");

const socket = new WebSocket(
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
);

/** The currently streaming assistant message element (null when not streaming). */
let activeAssistant = null;
let activeRaw = "";
/** The current turn's thinking block, reused for all streamed thinking chunks. */
let activeThinking = null;
/** True while a turn is in flight; gates the composer. */
let busy = false;
/** True while waiting for the initial /model list to populate the dropdown. */
let pendingModelList = false;
/** True while waiting for the initial /profile list to populate the dropdown. */
let pendingProfileList = false;
/** True while waiting for the initial /reasoning list to mark the active level. */
let pendingReasoningList = false;
/** True while waiting for the initial /tool list to populate the tools panel. */
let pendingToolList = false;
/** True while waiting for the initial /resume list to populate the sessions panel. */
let pendingSessionList = false;
/** Name of a tool whose toggle result is in flight (for feedback + refresh). */
let pendingToolToggle = null;

function setStatus(text) {
  status.textContent = text;
}

function addLine(cls, text) {
  const div = document.createElement("div");
  div.className = `line ${cls}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function newAssistantLine() {
  const div = document.createElement("div");
  div.className = "line assistant";
  log.appendChild(div);
  activeAssistant = div;
  activeRaw = "";
  log.scrollTop = log.scrollHeight;
  return div;
}

function flushAssistant() {
  if (activeAssistant) {
    activeAssistant.textContent = activeRaw;
    activeAssistant = null;
    activeRaw = "";
  }
}

function appendThinking(text) {
  const chunk = text ?? "";
  if (!chunk) return;
  if (!activeThinking) activeThinking = addLine("thinking", "");
  activeThinking.textContent += chunk;
  log.scrollTop = log.scrollHeight;
}

function finishThinking() {
  activeThinking = null;
}

function setBusy(next) {
  busy = next;
  input.disabled = next;
  send.disabled = next;
  stopBtn.disabled = !next;
  modelSelect.disabled = next;
  profileSelect.disabled = next;
  reasoningSelect.disabled = next;
  toolsBtn.disabled = next;
  sessionsBtn.disabled = next;
}

function sendLine(text) {
  if (!text.trim()) return;
  setBusy(true);
  addLine("user", text);
  socket.send(JSON.stringify({ type: "line", text }));
}

// --- input handling ---------------------------------------------------------

send.addEventListener("click", () => {
  sendLine(input.value);
  input.value = "";
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendLine(input.value);
    input.value = "";
  }
});

stopBtn.addEventListener("click", () => {
  socket.send(JSON.stringify({ type: "interrupt" }));
});

modelSelect.addEventListener("change", () => {
  const name = modelSelect.value;
  if (!name) return;
  pendingModelList = false;
  addLine("user", `/model ${name}`);
  setBusy(true);
  socket.send(JSON.stringify({ type: "line", text: `/model ${name}` }));
});

profileSelect.addEventListener("change", () => {
  const name = profileSelect.value;
  if (!name) return;
  pendingProfileList = false;
  addLine("user", `/profile ${name}`);
  setBusy(true);
  socket.send(JSON.stringify({ type: "line", text: `/profile ${name}` }));
});

reasoningSelect.addEventListener("change", () => {
  const name = reasoningSelect.value;
  if (!name) return;
  pendingReasoningList = false;
  addLine("user", `/reasoning ${name}`);
  setBusy(true);
  socket.send(JSON.stringify({ type: "line", text: `/reasoning ${name}` }));
});

toolsBtn.addEventListener("click", () => {
  toolsPanel.classList.toggle("hidden");
});

sessionsBtn.addEventListener("click", () => {
  sessionsPanel.classList.toggle("hidden");
});

saveBtn.addEventListener("click", saveSession);
saveName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveSession();
  }
});

toolsList.addEventListener("change", (event) => {
  const checkbox = event.target;
  if (!(checkbox instanceof HTMLInputElement)) return;
  const name = checkbox.value;
  if (!name) return;
  const verb = checkbox.checked ? "enable" : "disable";
  checkbox.closest("li")?.classList.toggle("disabled", !checkbox.checked);
  pendingToolToggle = name;
  addLine("user", `/tool ${name} ${verb}`);
  setBusy(true);
  socket.send(JSON.stringify({ type: "line", text: `/tool ${name} ${verb}` }));
});

askSend.addEventListener("click", () => {
  submitAsk();
});
askAnswer.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitAsk();
  }
});

function submitAsk() {
  const answer = askAnswer.value;
  askAnswer.value = "";
  hideAsk();
  socket.send(JSON.stringify({ type: "ask_answer", text: answer }));
}

function showAsk(message) {
  askQuestion.textContent = message.question ?? "";
  askOptions.textContent = "";
  const options = message.options ?? [];
  options.forEach((opt, i) => {
    const li = document.createElement("li");
    li.textContent = `${i + 1}. ${opt}`;
    askOptions.appendChild(li);
  });
  ask.classList.remove("hidden");
  askAnswer.focus();
}

function hideAsk() {
  ask.classList.add("hidden");
  askQuestion.textContent = "";
  askOptions.textContent = "";
}

// --- server messages --------------------------------------------------------

socket.addEventListener("open", () => {
  setStatus("connected");
  addLine("system", "Connected. Type a message to begin.");
  pendingModelList = true;
  pendingProfileList = true;
  pendingToolList = true;
  pendingSessionList = true;
  pendingReasoningList = true;
  setBusy(true);
  socket.send(JSON.stringify({ type: "line", text: "/model" }));
  // /profile is sent after /model resolves to keep the chain sequential.
  // /tool is sent after /profile resolves; see handleResult.
  // /resume is sent after /tool resolves.
});

socket.addEventListener("close", () => {
  setStatus("disconnected");
  flushAssistant();
  setBusy(false);
});

socket.addEventListener("message", (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  switch (message.type) {
    case "token":
      if (!activeAssistant) newAssistantLine();
      activeRaw += message.text ?? "";
      if (activeAssistant) {
        activeAssistant.textContent = activeRaw;
        log.scrollTop = log.scrollHeight;
      }
      break;
    case "thinking":
      appendThinking(message.text);
      break;
    case "tool":
      finishThinking();
      addLine(
        "tool",
        `tool: ${message.name ?? "unknown"}${message.depth ? ` (subagent)` : ""}`,
      );
      break;
    case "progress":
      break;
    case "result":
      finishThinking();
      handleResult(message);
      break;
    case "ask":
      showAsk(message);
      break;
    case "exit":
      finishThinking();
      addLine("system", "Session ended.");
      setBusy(false);
      break;
  }
});

function populateModelSelect(listText) {
  const lines = listText.split("\n");
  modelSelect.textContent = "";
  let activeFound = false;
  let modelCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "no models available") {
      modelCount = -1;
      break;
    }
    modelCount++;
    const option = document.createElement("option");
    if (line[0] === "*") {
      // formatModelList: `* <name> (active)`
      const raw = line.slice(1).trim();
      option.value = raw.replace(/ \(active\)$/, "");
      option.textContent = option.value;
      modelSelect.appendChild(option);
      modelSelect.value = option.value;
      activeFound = true;
    } else {
      // formatModelList: `  <name>` (two leading spaces)
      option.value = trimmed;
      option.textContent = trimmed;
      modelSelect.appendChild(option);
    }
  }
  if (modelCount === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "no models available";
    option.disabled = true;
    modelSelect.appendChild(option);
  } else if (!activeFound && modelCount > 0) {
    // Active model not in list — insert a placeholder first.
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "no active model";
    placeholder.disabled = true;
    modelSelect.insertBefore(placeholder, modelSelect.firstChild);
  }
}

/**
 * Populate the reasoning dropdown from the `/reasoning` list output and select
 * the active level. Replaces the placeholder option with the real levels.
 */
function populateReasoningSelect(listText) {
  reasoningSelect.textContent = "";
  const lines = listText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "no reasoning efforts available") {
      reasoningSelect.value = "";
      break;
    }
    const option = document.createElement("option");
    if (line[0] === "*") {
      // formatReasoningList: `* <level> (active)`
      const raw = line.slice(1).trim();
      option.value = raw.replace(/ \(active\)$/, "");
      option.textContent = option.value;
      reasoningSelect.appendChild(option);
      reasoningSelect.value = option.value;
    } else {
      // formatReasoningList: `  <level>` (two leading spaces)
      option.value = trimmed;
      option.textContent = trimmed;
      reasoningSelect.appendChild(option);
    }
  }
}

/** Remove the "no active profile" placeholder option (value="") if present. */
function removeProfilePlaceholder() {
  const option = profileSelect.querySelector('option[value=""]');
  if (option) profileSelect.removeChild(option);
}

/** Insert the "no active profile" placeholder if not already present. */
function addProfilePlaceholder() {
  if (profileSelect.querySelector('option[value=""]')) return;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "no active profile";
  placeholder.disabled = true;
  profileSelect.insertBefore(placeholder, profileSelect.firstChild);
}

/**
 * Rebuild the tools panel from a /tool list response (formatToolList output).
 * Each tool becomes a row with an enable/disable checkbox; disabled tools are
 * dimmed. When the panel is empty (no tools) a "no tools available" note is
 * shown.
 */
function populateToolsPanel(listText) {
  const lines = listText.split("\n");
  toolsList.textContent = "";
  let toolCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "no tools available") {
      toolCount = -1;
      break;
    }
    toolCount++;
    // formatToolList: `* <name> (enabled)` or `  <name> (disabled)`.
    const enabled = line[0] === "*";
    const raw = enabled ? line.slice(1).trim() : line.trimStart();
    const name = raw.replace(/ \(enabled\)$/, "").replace(/ \(disabled\)$/, "");
    const li = document.createElement("li");
    if (!enabled) li.classList.add("disabled");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = name;
    checkbox.checked = enabled;
    const label = document.createElement("label");
    label.appendChild(checkbox);
    const span = document.createElement("span");
    span.textContent = name;
    label.appendChild(span);
    li.appendChild(label);
    toolsList.appendChild(li);
  }
  if (toolCount === 0) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = "no tools available";
    li.appendChild(span);
    toolsList.appendChild(li);
  }
}

function populateProfileSelect(listText) {
  const lines = listText.split("\n");
  profileSelect.textContent = "";
  let activeFound = false;
  let profileCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "no profiles found") {
      profileCount = -1;
      break;
    }
    profileCount++;
    const option = document.createElement("option");
    if (line[0] === "*") {
      // formatProfileList: `* <name> (active)`
      const raw = line.slice(1).trim();
      option.value = raw.replace(/ \(active\)$/, "");
      option.textContent = option.value;
      profileSelect.appendChild(option);
      profileSelect.value = option.value;
      activeFound = true;
    } else {
      // formatProfileList: `  <name>` (two leading spaces)
      option.value = trimmed;
      option.textContent = trimmed;
      profileSelect.appendChild(option);
    }
  }
  if (profileCount === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "no profiles";
    option.disabled = true;
    profileSelect.appendChild(option);
  } else if (!activeFound && profileCount > 0) {
    // No active profile — insert a placeholder first.
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "no active profile";
    placeholder.disabled = true;
    profileSelect.insertBefore(placeholder, profileSelect.firstChild);
  }
}

/**
 * Rebuild the sessions panel from a /resume list response (formatSessionList
 * output). Each session becomes a clickable row. A save input + button row is
 * always present (it is static HTML, not built here).
 */
function populateSessionsPanel(listText) {
  sessionsList.textContent = "";
  const lines = listText.split("\n");
  let count = 0;
  for (const line of lines) {
    if (line.startsWith("  ") && !line.startsWith("    ")) {
      const name = line.trim();
      if (!name) continue;
      count++;
      const li = document.createElement("li");
      li.className = "session-row";

      const label = document.createElement("span");
      label.className = "session-name";
      label.textContent = name;
      label.addEventListener("click", () => resumeSession(name));
      li.appendChild(label);

      const del = document.createElement("button");
      del.className = "session-delete";
      del.textContent = "×";
      del.title = `delete ${name}`;
      del.addEventListener("click", () => deleteSession(name));
      li.appendChild(del);

      sessionsList.appendChild(li);
    }
  }
  if (count === 0) {
    const li = document.createElement("li");
    li.textContent = "no saved sessions";
    sessionsList.appendChild(li);
  }
}

function resumeSession(name) {
  addLine("user", `/resume ${name}`);
  setBusy(true);
  socket.send(JSON.stringify({ type: "line", text: `/resume ${name}` }));
}

function deleteSession(name) {
  addLine("user", `/delete ${name}`);
  setBusy(true);
  socket.send(JSON.stringify({ type: "line", text: `/delete ${name}` }));
}

function saveSession() {
  const name = saveName.value.trim();
  if (!name) return;
  saveName.value = "";
  addLine("user", `/save ${name}`);
  setBusy(true);
  socket.send(JSON.stringify({ type: "line", text: `/save ${name}` }));
}

/**
 * Update the persistent context-fill footer from the server's report.
 * `message.context` is `formatContext(used, max)` output, e.g.
 * "context: 45 / 141568 tokens (0%)". We parse the trailing percentage to
 * flag the near-full state (auto-compact fires at 0.9).
 */
function renderContext(message) {
  if (!message.context) return;
  contextEl.textContent = message.context;
  const pctMatch = message.context.match(/\(([\d.]+)%\)$/);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    contextEl.classList.toggle("warning", pct >= 90);
  }
}

function handleResult(message) {
  flushAssistant();
  hideAsk();
  renderContext(message);
  if (pendingModelList) {
    pendingModelList = false;
    if (message.ok === true && message.value) {
      populateModelSelect(message.value);
      // Keep the composer busy while /profile is in flight.
      setBusy(true);
      socket.send(JSON.stringify({ type: "line", text: "/profile" }));
      return;
    }
    // /model failed — don't send /profile; disable the profile dropdown.
    setBusy(false);
    profileSelect.disabled = true;
    addLine("error", message.error ?? "unknown error");
    return;
  }
  if (pendingProfileList) {
    pendingProfileList = false;
    if (message.ok === true && message.value) {
      populateProfileSelect(message.value);
      // Keep the composer busy while /tool is in flight.
      setBusy(true);
      socket.send(JSON.stringify({ type: "line", text: "/tool" }));
      return;
    }
    // /profile failed — don't send /tool.
    pendingToolList = false;
    setBusy(false);
    addLine("error", message.error ?? "unknown error");
    return;
  }
  if (pendingToolList) {
    pendingToolList = false;
    if (message.ok === true && message.value) {
      populateToolsPanel(message.value);
      // Keep the composer busy while /reasoning is in flight.
      setBusy(true);
      socket.send(JSON.stringify({ type: "line", text: "/reasoning" }));
      return;
    }
    setBusy(false);
    return;
  }
  if (pendingReasoningList) {
    pendingReasoningList = false;
    if (message.ok === true && message.value) {
      populateReasoningSelect(message.value);
      // Keep the composer busy while /resume is in flight.
      setBusy(true);
      socket.send(JSON.stringify({ type: "line", text: "/resume" }));
      return;
    }
    // /reasoning failed — don't send /resume; leave the dropdown as-is.
    setBusy(false);
    reasoningSelect.disabled = true;
    addLine("error", message.error ?? "unknown error");
    return;
  }
  if (pendingSessionList) {
    pendingSessionList = false;
    if (message.ok === true && message.value) {
      populateSessionsPanel(message.value);
    }
    setBusy(false);
    return;
  }
  if (pendingToolToggle) {
    const toolName = pendingToolToggle;
    pendingToolToggle = null;
    if (message.ok === true) {
      addLine("system", message.value);
      // Refresh the panel to reflect the new enabled state.
      socket.send(JSON.stringify({ type: "line", text: "/tool" }));
      pendingToolList = true;
    } else {
      // Toggle failed — revert the checkbox.
      const cb = Array.from(
        document.getElementById("tools-list").querySelectorAll("input"),
      ).find((cb) => cb.value === toolName);
      if (cb) {
        cb.checked = true;
        cb.closest("li")?.classList.remove("disabled");
      }
      addLine("error", message.error ?? "unknown error");
    }
    setBusy(false);
    return;
  }
  setBusy(false);
  if (message.ok === true) {
    if (message.value?.startsWith("resumed session ")) {
      log.textContent = "";
      addLine("system", message.value);
    } else if (message.value?.startsWith("saved session ")) {
      addLine("system", message.value);
      // Refresh the sessions list.
      socket.send(JSON.stringify({ type: "line", text: "/resume" }));
      pendingSessionList = true;
    } else if (message.value?.startsWith("deleted session ")) {
      addLine("system", message.value);
      // Refresh the sessions list.
      socket.send(JSON.stringify({ type: "line", text: "/resume" }));
      pendingSessionList = true;
    } else if (message.value?.startsWith("switched to model ")) {
      modelSelect.value = message.value.slice("switched to model ".length);
      addLine("system", `model: ${modelSelect.value}`);
    } else if (message.value?.startsWith("profile set to ")) {
      const name = message.value.slice("profile set to ".length);
      removeProfilePlaceholder();
      profileSelect.value = name;
      addLine("system", `profile: ${name}`);
    } else if (message.value?.startsWith("reasoning effort set to ")) {
      const name = message.value.slice("reasoning effort set to ".length);
      // The confirmation text drops the " (template default)" suffix; the
      // raw level is what the dropdown option holds.
      const level = name.replace(" (template default)", "");
      if (reasoningSelect.querySelector(`option[value="${level}"]`)) {
        reasoningSelect.value = level;
      }
      addLine("system", `reasoning: ${level}`);
    } else if (message.value === "profile cleared") {
      addProfilePlaceholder();
      profileSelect.value = "";
      addLine("system", "profile cleared");
    } else if (!message.streamed && message.value) {
      addLine("assistant", message.value);
    }
    if (message.compactionWarning) {
      addLine("system", message.compactionWarning);
    }
  } else {
    addLine("error", message.error ?? "unknown error");
  }
}
