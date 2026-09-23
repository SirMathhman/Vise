// Vise web client. Connects to the server's WebSocket, renders streamed
// ServerMessage frames, and sends ClientMessage frames (input / close).
// Vanilla JS, no framework. Markdown replies are rendered with the marked
// UMD build loaded from /marked.umd.js (sets the global `marked`).

(() => {
  var socket = null;
  var intentionalClose = false;
  var currentReply = null; // { el, buf } for the in-flight assistant reply
  // Open tool blocks indexed by nesting depth. Tool calls run one at a time,
  // so a call at depth d always belongs to the open block at depth d - 1 (the
  // run_subagent that spawned it) and ends before its parent does.
  var openToolBlocks = [];

  // --- DOM refs (populated in init) ---
  var connStateEl,
    statusLineEl,
    messagesEl,
    questionEl,
    diagnosticsEl,
    inputEl,
    sendEl,
    sessionsListEl,
    sessionNameInputEl,
    sessionSaveBtnEl,
    sessionRefreshBtnEl;

  function init() {
    connStateEl = document.getElementById("conn-state");
    statusLineEl = document.getElementById("status-line");
    messagesEl = document.getElementById("messages");
    questionEl = document.getElementById("question");
    diagnosticsEl = document.getElementById("diagnostics-body");
    inputEl = document.getElementById("input");
    sendEl = document.getElementById("send");
    sessionsListEl = document.getElementById("sessions-list");
    sessionNameInputEl = document.getElementById("session-name-input");
    sessionSaveBtnEl = document.getElementById("session-save-btn");
    sessionRefreshBtnEl = document.getElementById("session-refresh-btn");

    sendEl.addEventListener("click", onSendClick);
    inputEl.addEventListener("keydown", onInputKeydown);
    sessionSaveBtnEl.addEventListener("click", onSessionSaveClick);
    sessionNameInputEl.addEventListener("keydown", onSessionNameKeydown);
    sessionRefreshBtnEl.addEventListener("click", () =>
      sendCommand("/sessions"),
    );

    connect();
  }

  function wsUrl() {
    var proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  }

  function connect() {
    var url = wsUrl();
    socket = new WebSocket(url);
    setConnState("connecting");

    socket.addEventListener("open", () => {
      setConnState("open");
      intentionalClose = false;
    });

    socket.addEventListener("message", (ev) => {
      handleServerMessage(ev.data);
    });

    socket.addEventListener("close", () => {
      setConnState("closed");
      markOpenToolBlocksDisconnected();
      if (!intentionalClose) {
        // Auto-reconnect after a network drop. The server keeps the
        // session alive across disconnects, so the conversation continues.
        setTimeout(() => {
          if (
            socket &&
            socket.readyState === WebSocket.CLOSED &&
            !intentionalClose
          ) {
            connect();
          }
        }, 800);
      }
    });

    socket.addEventListener("error", () => {
      setConnState("error");
    });
  }

  function setConnState(state) {
    connStateEl.textContent = state;
    connStateEl.className = `conn-state ${state}`;
  }

  function send(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  // Sends a line of input as if typed in the composer: echoes it as a user
  // message, then transmits it. Used by the composer's own Send button.
  function sendLine(text) {
    send({ type: "input", text });
    makeLine("msg user", text);
    questionEl.hidden = true;
    setStatus("");
  }

  // Sends a line of input triggered by a UI control (the sessions panel's
  // buttons) rather than typed by the user. Unlike sendLine, this does not
  // echo the text as a user message — the command's own rendered result
  // (always sent back, per the built-in-commands contract) is the feedback.
  function sendCommand(text) {
    send({ type: "input", text });
  }

  // --- Rendering helpers ---
  // Assistant text isn't purely model-authored: it routinely echoes tool
  // output (read_file, search_content, ...) read from the working tree, so
  // HTML/script markup can end up in it (accidentally or via a prompt
  // injection). marked() doesn't escape raw HTML, so the parsed output is
  // sanitized before it ever reaches innerHTML. Without DOMPurify (load
  // failure), fall through to plain-text rendering rather than risk
  // unsanitized HTML.
  function renderMarkdown(el, text) {
    if (
      typeof marked !== "undefined" &&
      marked.parse &&
      typeof DOMPurify !== "undefined"
    ) {
      el.innerHTML = DOMPurify.sanitize(marked.parse(text));
    } else {
      el.textContent = text;
    }
  }

  function makeAssistantReply() {
    const el = document.createElement("div");
    el.className = "msg assistant";
    const body = document.createElement("div");
    body.className = "md";
    el.appendChild(body);
    messagesEl.appendChild(el);
    scrollDown();
    return { el, body, buf: "" };
  }

  // Builds a tool block inside `parentEl` (the message list, or the children
  // area of the subagent block that made the call). Arguments render as
  // `key: value` lines with string values verbatim, so multi-line task text
  // shows real line breaks instead of JSON-escaped "\n".
  function makeToolBlock(name, args, parentEl) {
    const el = document.createElement("div");
    el.className = "tool-block";
    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;
    el.appendChild(nameEl);
    const argsEl = document.createElement("pre");
    argsEl.className = "args";
    argsEl.textContent = Object.entries(args || {})
      .map(([key, value]) => {
        const text =
          typeof value === "string" ? value : JSON.stringify(value, null, 2);
        return `${key}: ${text}`;
      })
      .join("\n");
    el.appendChild(argsEl);
    const childrenEl = document.createElement("div");
    childrenEl.className = "children";
    el.appendChild(childrenEl);
    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = "running…";
    el.appendChild(metaEl);
    parentEl.appendChild(el);
    // Long arguments (e.g. a whole file for create_file) are clipped to a
    // preview; clicking the preview toggles the full text.
    if (argsEl.scrollHeight > argsEl.clientHeight) {
      argsEl.classList.add("clipped");
      argsEl.title = "Click to show all";
      argsEl.addEventListener("click", () => {
        const expanded = argsEl.classList.toggle("expanded");
        argsEl.title = expanded ? "Click to collapse" : "Click to show all";
      });
    }
    scrollDown();
    return { el, meta: metaEl, children: childrenEl };
  }

  function makeLine(className, text, extraClass) {
    const el = document.createElement("div");
    el.className = extraClass ? `${className} ${extraClass}` : className;
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollDown();
    return el;
  }

  function makePreLines(className, lines, isError) {
    const el = document.createElement("div");
    el.className = isError ? `${className} error` : className;
    el.textContent = lines.join("\n");
    messagesEl.appendChild(el);
    scrollDown();
    return el;
  }

  function scrollDown() {
    const chat = document.getElementById("chat");
    chat.scrollTop = chat.scrollHeight;
  }

  function setStatus(text) {
    if (text) {
      statusLineEl.textContent = text;
      statusLineEl.hidden = false;
    } else {
      statusLineEl.hidden = true;
      statusLineEl.textContent = "";
    }
  }

  function appendDiagnostics(line) {
    diagnosticsEl.appendChild(document.createTextNode(`${line}\n`));
    // Keep only the last ~50 lines so the panel doesn't grow unbounded.
    const lines = diagnosticsEl.childNodes;
    while (lines.length > 50) lines[0].remove();
  }

  // --- Server message dispatch ---
  function handleServerMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "prompt":
        break;
      case "reply_delta":
        onReplyDelta(msg.text);
        break;
      case "reply_end":
        onReplyEnd();
        break;
      case "reply_cancel":
        onReplyCancel();
        break;
      case "question":
        onQuestion(msg);
        break;
      case "tool_call_start":
        onToolCallStart(msg);
        break;
      case "tool_call_end":
        onToolCallEnd(msg);
        break;
      case "command":
        onCommand(msg);
        break;
      case "error":
        onError(msg.message);
        break;
      case "hook":
        onHook(msg);
        break;
      case "compact_notice":
        onCompactNotice();
        break;
      case "log":
        onLog(msg.message);
        break;
      case "status":
        onStatus(msg);
        break;
      case "session_in_use":
        intentionalClose = true;
        makeLine("error-line", "Another browser tab holds this session.");
        break;
      case "done":
        setStatus("");
        break;
      default:
        break;
    }
  }

  function onReplyDelta(text) {
    if (!currentReply) currentReply = makeAssistantReply();
    currentReply.buf += text;
    renderMarkdown(currentReply.body, currentReply.buf);
    scrollDown();
  }

  function onReplyEnd() {
    if (currentReply) {
      renderMarkdown(currentReply.body, currentReply.buf);
      currentReply = null;
    }
    setStatus("");
  }

  function onReplyCancel() {
    if (currentReply) {
      renderMarkdown(currentReply.body, currentReply.buf);
      currentReply = null;
    }
    setStatus("");
  }

  function onQuestion(msg) {
    questionEl.innerHTML = "";
    var qtext = document.createElement("div");
    qtext.className = "qtext";
    qtext.textContent = msg.question;
    questionEl.appendChild(qtext);
    if (msg.options && msg.options.length > 0) {
      const opts = document.createElement("div");
      opts.className = "qoptions";
      opts.textContent = `options: ${msg.options.join("  |  ")}`;
      questionEl.appendChild(opts);
    }
    questionEl.hidden = false;
    inputEl.focus();
  }

  function onToolCallStart(msg) {
    // Anything left open at this depth or deeper is stale (e.g. a turn that
    // died mid-call); drop it so the new call nests under the right parent.
    openToolBlocks.length = msg.depth;
    const parent = openToolBlocks[msg.depth - 1];
    openToolBlocks[msg.depth] = makeToolBlock(
      msg.name,
      msg.args,
      parent ? parent.children : messagesEl,
    );
  }

  function onToolCallEnd(msg) {
    const entry = openToolBlocks[msg.depth];
    if (!entry) return;
    openToolBlocks.length = msg.depth;
    const seconds = (msg.durationMs / 1000).toFixed(1);
    entry.meta.textContent = `${msg.status} · ${seconds} s${msg.error ? ` — ${msg.error}` : ""}`;
    entry.el.className = `tool-block ${msg.status === "done" ? "done" : msg.status === "failed" ? "failed" : ""}`;
  }

  // On a socket drop, relabels still-running tool blocks: their end events
  // are lost with the socket, but the server keeps the turn going, so the
  // outcome is unknown rather than failed.
  function markOpenToolBlocksDisconnected() {
    for (const entry of openToolBlocks) {
      if (entry) entry.meta.textContent = "disconnected (outcome unknown)";
    }
    openToolBlocks.length = 0;
  }

  function onCommand(msg) {
    makePreLines("command-line", msg.lines, msg.isError);
    if (Array.isArray(msg.sessionNames)) {
      renderSessionsList(msg.sessionNames);
    }
  }

  function onError(message) {
    makeLine("error-line", message);
  }

  function onHook(msg) {
    const ok = msg.exitCode === 0;
    makeLine("hook-line", `[${msg.label}] ${msg.output}`, ok ? "ok" : "bad");
  }

  function onCompactNotice() {
    makeLine("compact-line", "conversation compacted");
  }

  function onLog(message) {
    appendDiagnostics(message);
  }

  function onStatus(msg) {
    if (msg.phase === "thinking") {
      setStatus(
        `thinking${typeof msg.tokens === "number" ? ` · ${msg.tokens} tokens` : ""}${typeof msg.elapsedMs === "number" ? ` · ${Math.round(msg.elapsedMs / 1000)}s` : ""}`,
      );
    } else if (msg.phase === "prefill") {
      setStatus(
        `prefilling${typeof msg.processed === "number" && typeof msg.total === "number" ? ` · ${msg.processed}/${msg.total}` : ""}${typeof msg.cache === "number" ? ` · cache ${msg.cache}` : ""}${typeof msg.elapsedMs === "number" ? ` · ${Math.round(msg.elapsedMs / 1000)}s` : ""}`,
      );
    } else if (msg.phase === "done") {
      setStatus("");
    }
  }

  // --- Composer ---
  function onSendClick() {
    const text = inputEl.value.replace(/\r\n/g, "\n");
    if (text.trim().length === 0) return;
    inputEl.value = "";
    autoresize();
    sendLine(text);
  }

  function onInputKeydown(ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      onSendClick();
    }
  }

  // --- Sessions panel ---
  function onSessionSaveClick() {
    const name = sessionNameInputEl.value.trim();
    if (!name) return;
    sessionNameInputEl.value = "";
    sendCommand(`/save ${name}`);
  }

  function onSessionNameKeydown(ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      onSessionSaveClick();
    }
  }

  function renderSessionsList(names) {
    sessionsListEl.innerHTML = "";
    if (names.length === 0) {
      const empty = document.createElement("li");
      empty.className = "sessions-empty";
      empty.textContent = "No saved sessions.";
      sessionsListEl.appendChild(empty);
      return;
    }
    for (const name of names) {
      sessionsListEl.appendChild(makeSessionRow(name));
    }
  }

  function makeSessionRow(name) {
    const li = document.createElement("li");
    li.className = "session-row";

    const nameEl = document.createElement("span");
    nameEl.className = "session-name";
    nameEl.textContent = name;
    li.appendChild(nameEl);

    const actions = document.createElement("span");
    actions.className = "session-actions";

    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.textContent = "Load";
    loadBtn.addEventListener("click", () => sendCommand(`/load ${name}`));
    actions.appendChild(loadBtn);

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", () => {
      const next = window.prompt(`Rename "${name}" to:`, name);
      const trimmed = next ? next.trim() : "";
      if (trimmed && trimmed !== name) {
        sendCommand(`/sessions rename ${name} ${trimmed}`);
      }
    });
    actions.appendChild(renameBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      if (window.confirm(`Delete saved session "${name}"?`)) {
        sendCommand(`/sessions delete ${name}`);
      }
    });
    actions.appendChild(deleteBtn);

    li.appendChild(actions);
    return li;
  }

  function autoresize() {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 240)}px`;
  }

  // Page unload (navigate away / reload). The server only detaches the
  // socket, so the reloaded page reattaches to the same session.
  window.addEventListener("beforeunload", () => {
    intentionalClose = true;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  });

  document.addEventListener("DOMContentLoaded", init);
})();
