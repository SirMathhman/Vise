// Vise web client. Connects to the server's WebSocket, renders streamed
// ServerMessage frames, and sends ClientMessage frames (input / close).
// Vanilla JS, no framework. Markdown replies are rendered with the marked
// UMD build loaded from /marked.umd.js (sets the global `marked`).

(() => {
  var socket = null;
  var intentionalClose = false;
  var currentReply = null; // { el, buf } for the in-flight assistant reply
  var toolBlocks = new Map(); // keyed "<name>::<seq>" -> { el, meta, started }
  var toolSeq = 0;

  // --- DOM refs (populated in init) ---
  var connStateEl,
    statusLineEl,
    messagesEl,
    questionEl,
    diagnosticsEl,
    inputEl,
    sendEl;

  function init() {
    connStateEl = document.getElementById("conn-state");
    statusLineEl = document.getElementById("status-line");
    messagesEl = document.getElementById("messages");
    questionEl = document.getElementById("question");
    diagnosticsEl = document.getElementById("diagnostics-body");
    inputEl = document.getElementById("input");
    sendEl = document.getElementById("send");

    sendEl.addEventListener("click", onSendClick);
    inputEl.addEventListener("keydown", onInputKeydown);

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
      if (!intentionalClose) {
        // Auto-reconnect after a refresh/network drop. The server resumes
        // from .vise/session.json, so the conversation continues.
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

  // --- Rendering helpers ---
  function renderMarkdown(el, text) {
    if (typeof marked !== "undefined" && marked.parse) {
      el.innerHTML = marked.parse(text);
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

  function makeToolBlock(name, args) {
    const el = document.createElement("div");
    el.className = "tool-block";
    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;
    el.appendChild(nameEl);
    const argsEl = document.createElement("pre");
    argsEl.className = "args";
    argsEl.textContent = JSON.stringify(args, null, 2);
    el.appendChild(argsEl);
    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    el.appendChild(metaEl);
    messagesEl.appendChild(el);
    scrollDown();
    return { el, meta: metaEl };
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
    var block = makeToolBlock(msg.name, msg.args);
    toolBlocks.set(`${msg.name}::${++toolSeq}`, {
      el: block.el,
      meta: block.meta,
      started: true,
    });
  }

  function onToolCallEnd(msg) {
    // Match the most recent started tool block with the same name.
    var key = null;
    var keys = Array.from(toolBlocks.keys());
    for (let i = keys.length - 1; i >= 0; i--) {
      if (keys[i].indexOf(`${msg.name}::`) === 0) {
        key = keys[i];
        break;
      }
    }
    if (key !== null) {
      const entry = toolBlocks.get(key);
      if (entry?.meta) {
        entry.meta.textContent = `${msg.status === "done" ? "done" : msg.status} · ${Math.round(msg.durationMs)} ms · depth ${msg.depth}`;
        entry.el.className = `tool-block ${msg.status === "done" ? "done" : msg.status === "failed" ? "failed" : ""}`;
        entry.started = false;
        toolBlocks.delete(key);
      }
    }
  }

  function onCommand(msg) {
    makePreLines("command-line", msg.lines, msg.isError);
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
    makeLine("msg user", text);
    send({ type: "input", text });
    questionEl.hidden = true;
    setStatus("");
  }

  function onInputKeydown(ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      onSendClick();
    }
  }

  function autoresize() {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 240)}px`;
  }

  // Intentional close (user navigates away / reloads). The server saves the
  // session on shutdown, so reconnecting resumes from .vise/session.json.
  window.addEventListener("beforeunload", () => {
    intentionalClose = true;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  });

  document.addEventListener("DOMContentLoaded", init);
})();
