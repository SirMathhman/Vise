"use strict";
// The error, with the tool calls that ran before it: their effects remain even though the turn did not finish.
function describeFailure(error, ran) {
    if (!ran || ran.length === 0) {
        return error;
    }
    return `${error} ${ran.length} tool call(s) ran before this, and their effects remain: ${ran.join("; ")}`;
}
const conversation = [];
// The switched-off tools the model has been told about in this conversation.
let told = [];
// This tab's session: its switched-off tools live on the server under this id. It survives a reload of the tab and
// is dropped when the tab closes. Storage can be blocked, in which case the session lasts for this page load.
const SESSION_KEY = "vise-session";
function sessionId() {
    try {
        const stored = sessionStorage.getItem(SESSION_KEY);
        if (stored)
            return stored;
        const fresh = crypto.randomUUID();
        sessionStorage.setItem(SESSION_KEY, fresh);
        return fresh;
    }
    catch {
        return crypto.randomUUID();
    }
}
const session = sessionId();
const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const newButton = document.getElementById("new");
const stopButton = document.getElementById("stop");
const sendButton = document.getElementById("send");
// The request in flight, if any: Stop aborts it. Aborting closes the connection, and the server stops the turn.
let inFlight = null;
function addEntry(kind) {
    const entry = document.createElement("div");
    entry.className = kind;
    log.appendChild(entry);
    return entry;
}
function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
}
async function streamChat(messages, onEvent, signal) {
    let res;
    try {
        res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages, told, session }),
            signal,
        });
    }
    catch {
        throw new Error(`Could not reach the Vise server at ${location.origin}. Check that "vise web" is still running, then try again.`);
    }
    if (!res.ok || res.body === null) {
        const data = (await res.json().catch(() => ({})));
        throw new Error(describeFailure(data.error ?? `HTTP ${res.status}`, data.ran));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read().catch(() => {
            throw new Error("The connection dropped partway through the reply. Try again.");
        });
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf("\n\n");
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line === undefined) {
                continue;
            }
            const event = JSON.parse(line.slice("data: ".length));
            if (event.type === "error") {
                throw new Error(describeFailure(event.error, event.ran));
            }
            if (event.type === "done") {
                return event;
            }
            onEvent(event);
        }
    }
    throw new Error("The reply ended before it finished. Try again.");
}
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === "") {
        return;
    }
    input.value = "";
    // Tool commands are answered by the server and kept out of the conversation.
    const command = /^\/(tools|enable|disable)(\s|$)/.test(text);
    if (!command) {
        conversation.push({ role: "user", content: text });
    }
    addEntry("user").textContent = text;
    input.disabled = true;
    const bubble = addEntry("assistant");
    const thinking = document.createElement("details");
    thinking.className = "thinking";
    thinking.open = true;
    thinking.hidden = true;
    const thinkingSummary = document.createElement("summary");
    thinkingSummary.textContent = "Thinking";
    const thinkingText = document.createElement("div");
    thinking.append(thinkingSummary, thinkingText);
    let answerText = document.createElement("div");
    bubble.append(thinking, answerText);
    try {
        const messages = command ? [...conversation, { role: "user", content: text }] : conversation;
        const controller = new AbortController();
        inFlight = controller;
        sendButton.hidden = true;
        stopButton.hidden = false;
        const done = await streamChat(messages, (streamed) => {
            if (streamed.type === "reasoning") {
                thinking.hidden = false;
                thinkingText.textContent += streamed.text;
            }
            else if (streamed.type === "content") {
                answerText.textContent += streamed.text;
            }
            else if (streamed.type === "tool") {
                // Text after a tool call goes in a new block below it, so the order matches the stream.
                const toolLine = document.createElement("div");
                toolLine.className = "tool";
                toolLine.textContent = `[tool] ${streamed.text}`;
                answerText = document.createElement("div");
                bubble.append(toolLine, answerText);
            }
            scrollToEnd();
        }, controller.signal);
        if (!command) {
            // The server may have added a note about switch changes to this user message, and returns the
            // record of switches the model now knows about. Both are kept only once the reply has arrived.
            if (done.user_message != null) {
                conversation[conversation.length - 1].content = done.user_message;
            }
            if (done.told) {
                told = done.told;
            }
            conversation.push({ role: "assistant", content: done.answer });
            // A summary is appended after the reply. The earlier messages stay in the log, unchanged.
            if (done.summary != null) {
                conversation.push({ role: "summary", content: done.summary });
                addEntry("summary").textContent = "Earlier conversation summarized.";
            }
            else if (done.summary_failed != null) {
                conversation.push({ role: "summary_failed", content: done.summary_failed });
                addEntry("summary").textContent = "Could not summarize the conversation. It will be tried again later.";
            }
        }
    }
    catch (err) {
        if (!command) {
            conversation.pop();
        }
        if (inFlight?.signal.aborted) {
            // Stopped by the user: what streamed stays on screen, but the turn is not kept, as a failed one is not.
            addEntry("summary").textContent =
                "Stopped. Tool calls shown above may already have run, and their effects remain. This turn was not kept in the conversation.";
        }
        else {
            if (answerText.textContent === "" && thinkingText.textContent === "") {
                bubble.remove();
            }
            addEntry("error").textContent = err instanceof Error ? err.message : String(err);
        }
    }
    finally {
        inFlight = null;
        sendButton.hidden = false;
        stopButton.hidden = true;
        input.disabled = false;
        input.focus();
        // A typed /enable or /disable changes a switch on the server, so the panel is redrawn from it.
        void refreshTools();
        scrollToEnd();
    }
});
stopButton.addEventListener("click", () => {
    inFlight?.abort();
});
newButton.addEventListener("click", () => {
    conversation.length = 0;
    told = [];
    log.replaceChildren();
});
const toolsList = document.getElementById("tools-list");
const toolsError = document.getElementById("tools-error");
// Lists this tab's tools, or switches one of them, on the server. The panel always shows the server's answer, so it
// stays right when a tool is changed by a typed /enable or /disable.
async function sendTools(change) {
    const res = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, ...change }),
    });
    const data = (await res.json().catch(() => ({})));
    if (!res.ok || data.tools === undefined) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    return data.tools;
}
function renderTools(tools) {
    toolsList.replaceChildren(...tools.map((tool) => {
        const item = document.createElement("li");
        const label = document.createElement("label");
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = tool.enabled;
        toggle.addEventListener("change", async () => {
            toggle.disabled = true;
            try {
                renderTools(await sendTools({ name: tool.name, enabled: toggle.checked }));
                toolsError.hidden = true;
            }
            catch (err) {
                showToolsError(err);
                await refreshTools();
            }
        });
        const name = document.createElement("span");
        name.textContent = tool.name;
        label.append(toggle, name);
        const description = document.createElement("div");
        description.className = "description";
        description.textContent = tool.description;
        item.append(label, description);
        return item;
    }));
}
function showToolsError(err) {
    toolsError.textContent = err instanceof Error ? err.message : String(err);
    toolsError.hidden = false;
}
async function refreshTools() {
    try {
        renderTools(await sendTools());
        toolsError.hidden = true;
    }
    catch (err) {
        showToolsError(err);
    }
}
void refreshTools();
// The divider between the chat and the Tools panel. Dragging it sets the panel's width, which is kept in this browser.
const DIVIDER_KEY = "vise-tools-width";
const MIN_TOOLS_PX = 160;
const MIN_CHAT_PX = 320;
const divider = document.getElementById("divider");
const layout = document.querySelector(".layout");
let toolsWidth = 0;
function clampToolsWidth(px) {
    return Math.max(MIN_TOOLS_PX, Math.min(px, layout.clientWidth - MIN_CHAT_PX));
}
// The width the user chose is kept as it is. The width shown is clamped to the window, so the chosen width comes back
// when the window grows again.
function setToolsWidth(px) {
    toolsWidth = px;
    applyToolsWidth();
}
function applyToolsWidth() {
    document.documentElement.style.setProperty("--tools-width", `${clampToolsWidth(toolsWidth)}px`);
}
// Restores the width this browser last used. Storage can be blocked, in which case the default width is used.
try {
    const stored = Number(localStorage.getItem(DIVIDER_KEY));
    if (stored > 0) {
        setToolsWidth(stored);
    }
}
catch {
    // The default width stays.
}
let dragging = false;
divider.addEventListener("pointerdown", (event) => {
    dragging = true;
    divider.setPointerCapture(event.pointerId);
    event.preventDefault();
});
divider.addEventListener("pointermove", (event) => {
    if (dragging) {
        setToolsWidth(layout.getBoundingClientRect().right - event.clientX);
    }
});
function endDrag() {
    if (!dragging) {
        return;
    }
    dragging = false;
    try {
        localStorage.setItem(DIVIDER_KEY, String(toolsWidth));
    }
    catch {
        // Not saved: the width lasts for this page load only.
    }
}
divider.addEventListener("pointerup", endDrag);
divider.addEventListener("pointercancel", endDrag);
// A narrower window clamps the shown width without changing the chosen one, and nothing is saved here.
window.addEventListener("resize", () => {
    if (toolsWidth > 0) {
        applyToolsWidth();
    }
});
