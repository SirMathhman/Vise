"use strict";
// The text of a thrown value, as it is shown to the user.
function errorMessage(err) {
    return errorMessage(err);
}
// The error, with the tool calls that ran before it: their effects remain even though the turn did not finish.
function describeFailure(error, ran) {
    if (!ran || ran.length === 0) {
        return error;
    }
    return `${error} ${ran.length} tool call(s) ran before this, and their effects remain: ${ran.join("; ")}`;
}
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
// Raw HTML in markdown is shown as text, never inserted as HTML.
if (typeof marked !== "undefined") {
    marked.use({ renderer: { html: escapeHtml } });
}
// Markdown to sanitized HTML. Without the libraries the text is escaped, so it still shows as text.
function renderMarkdown(text) {
    if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
        return escapeHtml(text);
    }
    return DOMPurify.sanitize(marked.parse(text));
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
// A tool call's line in the reply.
function toolLine(text) {
    const line = document.createElement("div");
    line.className = "tool";
    line.textContent = `[tool] ${text}`;
    return line;
}
// A block that holds markdown text, which is rendered again as each piece arrives.
function markdownBlock() {
    const block = document.createElement("div");
    block.className = "markdown";
    return block;
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
function openSubagent(bubble, start) {
    const block = document.createElement("details");
    block.className = "subagent";
    block.open = true;
    const summary = document.createElement("summary");
    const label = `${start.profile}: ${start.task}`;
    summary.textContent = `Subagent running, ${label}`;
    block.append(summary);
    bubble.append(block);
    return { block, summary, label, part: null, partKind: null, raw: "" };
}
function subagentPart(sub, kind) {
    if (sub.part === null || sub.partKind !== kind) {
        const part = document.createElement("div");
        part.className = kind === "content" ? "markdown" : "thinking";
        sub.block.append(part);
        sub.part = part;
        sub.partKind = kind;
        sub.raw = "";
    }
    return sub.part;
}
function renderSubagentStep(sub, step) {
    if (step.type === "reasoning") {
        subagentPart(sub, "reasoning").textContent += step.text;
    }
    else if (step.type === "content") {
        const part = subagentPart(sub, "content");
        sub.raw += step.text;
        part.innerHTML = renderMarkdown(sub.raw);
    }
    else if (step.type === "tool") {
        sub.block.append(toolLine(step.text));
        sub.part = null;
        sub.partKind = null;
    }
}
// A finished subagent folds away, unless it failed, so the reason stays in view.
function closeSubagent(sub, failed) {
    sub.summary.textContent = failed ? `Subagent failed, ${sub.label}` : `Subagent finished, ${sub.label}`;
    sub.block.open = failed;
}
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === "") {
        return;
    }
    // The default profile must be in place before the user's message joins the conversation.
    input.disabled = true;
    await defaultProfile;
    input.value = "";
    // Tool commands are answered by the server and kept out of the conversation.
    const command = /^\/(tools|enable|disable|notes|profile)(\s|$)/.test(text);
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
    let answerText = markdownBlock();
    // The reply so far as the model wrote it. It is rendered again as each piece arrives.
    let answerRaw = "";
    bubble.append(thinking, answerText);
    try {
        const messages = command ? [...conversation, { role: "user", content: text }] : conversation;
        const controller = new AbortController();
        inFlight = controller;
        sendButton.hidden = true;
        stopButton.hidden = false;
        let subagent = null;
        const done = await streamChat(messages, (streamed) => {
            if (streamed.type === "reasoning") {
                thinking.hidden = false;
                thinkingText.textContent += streamed.text;
            }
            else if (streamed.type === "content") {
                answerRaw += streamed.text;
                answerText.innerHTML = renderMarkdown(answerRaw);
            }
            else if (streamed.type === "tool") {
                // Text after a tool call goes in a new block below it, so the order matches the stream.
                answerText = markdownBlock();
                answerRaw = "";
                bubble.append(toolLine(streamed.text), answerText);
            }
            else if (streamed.type === "subagent_start") {
                subagent = openSubagent(bubble, streamed);
            }
            else if (streamed.type === "nested") {
                if (subagent !== null) {
                    renderSubagentStep(subagent, streamed.event);
                }
            }
            else if (streamed.type === "subagent_end") {
                if (subagent !== null) {
                    closeSubagent(subagent, streamed.failed);
                }
                subagent = null;
                // Text after a subagent goes in a new block below it, as text after a tool call does.
                answerText = markdownBlock();
                answerRaw = "";
                bubble.append(answerText);
            }
            scrollToEnd();
        }, controller.signal);
        if (done.profile != null) {
            // A chosen profile's instructions join the conversation, so the later requests keep following them.
            conversation.push({ role: "profile", content: done.profile });
        }
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
            autosaveTurn();
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
            addEntry("error").textContent = errorMessage(err);
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
    defaultAbort?.abort();
});
newButton.addEventListener("click", () => {
    conversation.length = 0;
    told = [];
    autosaveName = null;
    log.replaceChildren();
    void applyDefaultProfile();
});
// The default profile's request, started on load and on New. The first message waits for it, so the profile's
// instructions join the conversation before the user's message does. Stop cancels it.
let defaultProfile = Promise.resolve();
let defaultAbort = null;
// Starts the conversation with the built-in default profile. The server applies its tools and returns its
// instructions, if it has any, which join the conversation. Nothing is shown in the log.
function applyDefaultProfile() {
    const controller = new AbortController();
    defaultAbort = controller;
    defaultProfile = (async () => {
        try {
            const done = await streamChat([{ role: "user", content: "/profile default" }], () => { }, controller.signal);
            if (done.profile != null) {
                conversation.push({ role: "profile", content: done.profile });
            }
        }
        catch (err) {
            if (!controller.signal.aborted) {
                addEntry("error").textContent = errorMessage(err);
            }
        }
        void refreshTools();
    })();
    return defaultProfile;
}
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
        description.innerHTML = renderMarkdown(tool.description);
        item.append(label, description);
        return item;
    }));
}
function showToolsError(err) {
    toolsError.textContent = errorMessage(err);
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
// Saved sessions in the side panel. The server writes and reads the files; loading replaces the conversation both on
// screen and in the history the next request sends.
const sessionForm = document.getElementById("session-form");
const sessionName = document.getElementById("session-name");
const sessionsList = document.getElementById("sessions-list");
const sessionsStatus = document.getElementById("sessions-status");
// Shows a message in one of the side panel's status lines. An error is shown as an error.
function showStatus(status, message, isError) {
    status.textContent = message;
    status.className = isError ? "error" : "summary";
    status.hidden = false;
}
async function refreshSessions() {
    try {
        const { sessions } = await postJson("/api/sessions", { action: "list" });
        sessionsList.replaceChildren(...sessions.map((name) => {
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = name;
            button.addEventListener("click", () => {
                void loadSession(name);
            });
            item.append(button);
            return item;
        }));
    }
    catch (err) {
        showStatus(sessionsStatus, errorMessage(err), true);
    }
}
// Adds one saved message to the log the way the live conversation showed it. Profile instructions are not shown.
function showMessage(message) {
    if (message.role === "user") {
        addEntry("user").textContent = message.content;
    }
    else if (message.role === "assistant") {
        const bubble = addEntry("assistant");
        const answer = markdownBlock();
        answer.innerHTML = renderMarkdown(message.content);
        bubble.append(answer);
    }
    else if (message.role === "summary") {
        addEntry("summary").textContent = "Earlier conversation summarized.";
    }
    else if (message.role === "summary_failed") {
        addEntry("summary").textContent = "Could not summarize the conversation. It will be tried again later.";
    }
}
sessionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = sessionName.value.trim();
    if (name === "") {
        return;
    }
    // A reply in flight is not part of the conversation yet, so the save waits for it.
    if (input.disabled) {
        showStatus(sessionsStatus, "Wait for the reply to finish, then save.", true);
        return;
    }
    try {
        const { message } = await postJson("/api/sessions", {
            action: "save",
            name,
            messages: conversation,
            told,
        });
        sessionName.value = "";
        showStatus(sessionsStatus, message, false);
        await refreshSessions();
    }
    catch (err) {
        showStatus(sessionsStatus, errorMessage(err), true);
    }
});
// The name this conversation autosaves under. It is picked at the first completed turn, and New or Load clears it so
// the next turn starts a new saved session.
let autosaveName = null;
// Saves the conversation after a completed turn. The save runs in the background: a failure shows in the Sessions
// panel, and the chat is unaffected.
function autosaveTurn() {
    autosaveName ??= `auto-${Date.now()}`;
    postJson("/api/sessions", {
        action: "save",
        name: autosaveName,
        messages: conversation,
        told,
    }).then(() => refreshSessions(), (err) => showStatus(sessionsStatus, errorMessage(err), true));
}
async function loadSession(name) {
    if (input.disabled) {
        showStatus(sessionsStatus, "Wait for the reply to finish, then load.", true);
        return;
    }
    // Input stays off while the session loads, so a message cannot slip in between the request and the replacement.
    input.disabled = true;
    try {
        const data = await postJson("/api/sessions", { action: "load", name });
        // The default profile must land before the loaded conversation, or it could join the conversation after it.
        await defaultProfile;
        conversation.length = 0;
        conversation.push(...data.messages);
        told = data.told;
        autosaveName = null;
        log.replaceChildren();
        data.messages.forEach(showMessage);
        showStatus(sessionsStatus, `Loaded session ${name}.`, false);
        scrollToEnd();
    }
    catch (err) {
        showStatus(sessionsStatus, errorMessage(err), true);
    }
    finally {
        input.disabled = false;
        input.focus();
    }
}
const filesTree = document.getElementById("files-tree");
const filesRefresh = document.getElementById("files-refresh");
// One entry as a row. A folder is a closed section that fetches its entries when first opened. A file is a button that
// opens it.
function treeItem(entry, dir) {
    const item = document.createElement("li");
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.dir) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = `${entry.name}/`;
        const body = document.createElement("div");
        // A folder is fetched when it is first opened. A failed fetch is tried again on the next opening.
        let fetched = false;
        let fetching = false;
        details.addEventListener("toggle", async () => {
            if (details.open && !fetched && !fetching) {
                fetching = true;
                fetched = (await loadFolderPage(path, body, null)) !== null;
                fetching = false;
            }
        });
        details.append(summary, body);
        item.append(details);
    }
    else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "file-link";
        button.textContent = entry.name;
        button.addEventListener("click", () => {
            openFile(path);
        });
        item.append(button);
    }
    return item;
}
// Adds one page of a folder's entries to its body, with Load more when more follow. A failed request shows its reason
// and keeps Load more, so the same page can be asked for again. The list and the controls are found as direct children,
// so a folder nested inside never picks up this one's controls.
// The folders whose page is being fetched. A second request for the same folder waits for the first, so a double click
// on Load more cannot append the same entries twice.
const fetchingFolders = new WeakSet();
async function loadFolderPage(dir, body, after) {
    if (fetchingFolders.has(body)) {
        return null;
    }
    fetchingFolders.add(body);
    body.querySelector(":scope > .tree-error")?.remove();
    let list = body.querySelector(":scope > ul");
    if (list === null) {
        list = document.createElement("ul");
        body.append(list);
    }
    try {
        const page = await postJson("/api/files", { dir, after });
        body.querySelector(":scope > .tree-more")?.remove();
        list.append(...page.entries.map((entry) => treeItem(entry, dir)));
        if (page.more && page.next !== null) {
            const next = page.next;
            const more = document.createElement("button");
            more.type = "button";
            more.className = "tree-more";
            more.textContent = "Load more";
            more.addEventListener("click", () => {
                void loadFolderPage(dir, body, next);
            });
            body.append(more);
        }
        return page;
    }
    catch (err) {
        const error = document.createElement("p");
        error.className = "error tree-error";
        error.textContent = errorMessage(err);
        body.append(error);
        return null;
    }
    finally {
        fetchingFolders.delete(body);
    }
}
const viewers = document.getElementById("viewers");
const viewersTabs = document.getElementById("viewers-tabs");
const viewersBody = document.getElementById("viewers-body");
const viewersCloseAll = document.getElementById("viewers-close-all");
const viewed = [];
let activePath = null;
function renderViewers() {
    viewers.hidden = viewed.length === 0;
    viewersTabs.replaceChildren(...viewed.map((file) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = file.path === activePath ? "viewer-tab active" : "viewer-tab";
        tab.textContent = file.path;
        tab.addEventListener("click", () => {
            activePath = file.path;
            renderViewers();
        });
        return tab;
    }));
    viewersBody.replaceChildren();
    const file = viewed.find((candidate) => candidate.path === activePath);
    if (file === undefined) {
        return;
    }
    const viewer = document.createElement("article");
    viewer.className = "viewer";
    const head = document.createElement("div");
    head.className = "viewer-head";
    const name = document.createElement("span");
    name.className = "viewer-name";
    name.textContent = file.path;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => closeFile(file.path));
    head.append(name, close);
    // The text is set as plain text, so nothing in it is read as HTML.
    const text = document.createElement("pre");
    text.textContent = file.lines.join("\n");
    const foot = document.createElement("div");
    foot.className = "viewer-foot";
    renderFoot(file, foot);
    viewer.append(head, text, foot);
    viewersBody.append(viewer);
}
// The controls under the text: the error, and Load more (or Loading…). Only this part is redrawn while a block loads.
function renderFoot(file, foot) {
    foot.replaceChildren();
    if (file.error !== null) {
        const error = document.createElement("p");
        error.className = "error";
        error.textContent = file.error;
        foot.append(error);
    }
    if (file.more) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "viewer-more";
        more.textContent = file.loading ? "Loading…" : "Load more";
        more.disabled = file.loading;
        more.addEventListener("click", () => {
            void loadBlock(file.path);
        });
        foot.append(more);
    }
}
// Redraws the foot of a file, if its tab is the one shown.
function refreshFoot(file) {
    if (file.path !== activePath) {
        return;
    }
    const foot = viewersBody.querySelector(".viewer-foot");
    if (foot !== null) {
        renderFoot(file, foot);
    }
}
// Adds a block's lines to a file. When its tab is the one shown, they are appended to the text already there.
function addLines(file, lines) {
    const text = (file.lines.length > 0 ? "\n" : "") + lines.join("\n");
    file.lines.push(...lines);
    if (file.path === activePath) {
        viewersBody.querySelector("pre")?.append(document.createTextNode(text));
    }
}
// Fetches the next block of a file that is still open. A response for a file that was closed meanwhile is dropped.
async function loadBlock(path) {
    const file = viewed.find((candidate) => candidate.path === path);
    if (file === undefined || file.loading) {
        return;
    }
    file.loading = true;
    file.error = null;
    refreshFoot(file);
    try {
        const data = await postJson("/api/file", {
            path,
            offset: file.next,
        });
        addLines(file, data.lines);
        file.next = data.next;
        file.more = data.more;
    }
    catch (err) {
        file.error = errorMessage(err);
    }
    finally {
        file.loading = false;
        refreshFoot(file);
    }
}
// Opens a file as a tab and makes it the one shown. Opening a file that is already open only shows its tab.
function openFile(path) {
    if (!viewed.some((file) => file.path === path)) {
        viewed.push({ path, lines: [], next: 0, more: false, loading: false, error: null });
        void loadBlock(path);
    }
    activePath = path;
    renderViewers();
}
// Closes one file. When it was the one shown, the file opened last takes its place.
function closeFile(path) {
    const index = viewed.findIndex((file) => file.path === path);
    if (index === -1) {
        return;
    }
    viewed.splice(index, 1);
    if (activePath === path) {
        activePath = viewed.length > 0 ? viewed[viewed.length - 1].path : null;
    }
    renderViewers();
}
viewersCloseAll.addEventListener("click", () => {
    viewed.length = 0;
    activePath = null;
    renderViewers();
});
async function refreshFiles() {
    filesTree.replaceChildren();
    const page = await loadFolderPage("", filesTree, null);
    if (page !== null) {
        const title = document.createElement("p");
        title.className = "description";
        title.textContent = `${page.name}/`;
        filesTree.prepend(title);
    }
}
filesRefresh.addEventListener("click", () => {
    void refreshFiles();
});
const notesList = document.getElementById("notes-list");
const notesStatus = document.getElementById("notes-status");
const notesNew = document.getElementById("notes-new");
const noteForm = document.getElementById("note-form");
const noteScope = document.getElementById("note-scope");
const noteCategory = document.getElementById("note-category");
const noteName = document.getElementById("note-name");
const noteContent = document.getElementById("note-content");
const noteDelete = document.getElementById("note-delete");
const notePreview = document.getElementById("note-preview");
const notePreviewToggle = document.getElementById("note-preview-toggle");
const profilePicker = document.getElementById("profile-picker");
const NEW_NOTE_TEXT = "---\nname: \nsummary: \n---\n";
// The note open in the editor. Null while a new note is being written.
let editing = null;
// One JSON request to the server. A failure is thrown with the server's reason.
async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({})));
    if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    return data;
}
// One request to the notes API.
function notesApi(body) {
    return postJson("/api/notes", body);
}
function setEditing(note, text) {
    editing = note;
    noteScope.value = note?.scope ?? "local";
    noteCategory.value = note?.category ?? "";
    noteName.value = note?.name ?? "";
    // An existing note keeps its address, so saving it cannot rename it.
    noteScope.disabled = note !== null;
    noteCategory.readOnly = note !== null;
    noteName.readOnly = note !== null;
    noteContent.value = text;
    noteDelete.hidden = note === null;
    showPreview(false);
}
// Shows the note's rendered markdown in place of the editor, or the editor again. Saving uses the editor's text.
function showPreview(on) {
    noteContent.hidden = on;
    notePreview.hidden = !on;
    notePreviewToggle.textContent = on ? "Edit" : "Preview";
    if (on) {
        notePreview.innerHTML = renderMarkdown(noteContent.value);
    }
    else {
        fitNoteContent();
    }
}
// The editor is as tall as its text, so it never scrolls inside the Notes pane. The height includes the border, which
// scrollHeight leaves out.
function fitNoteContent() {
    noteContent.style.height = "auto";
    const border = noteContent.offsetHeight - noteContent.clientHeight;
    noteContent.style.height = `${noteContent.scrollHeight + border}px`;
}
noteContent.addEventListener("input", fitNoteContent);
// Wrapping changes with the width, and an editor inside a closed section has no height until it is opened. Both are
// measured again when the editor's size changes.
new ResizeObserver(fitNoteContent).observe(noteContent);
notePreviewToggle.addEventListener("click", () => showPreview(notePreview.hidden === true));
async function refreshNotes() {
    try {
        const { notes: profiles } = await notesApi({ action: "profiles" });
        profilePicker.replaceChildren(new Option("Use a profile…", ""), ...profiles.map((profile) => new Option(`${profile.scope} ${profile.category}/${profile.name}`, `${profile.scope}/${profile.category}/${profile.name}`)));
        const { notes } = await notesApi({ action: "list" });
        notesList.replaceChildren(...notes.map((note) => {
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = `${note.scope} ${note.category}/${note.name}`;
            button.addEventListener("click", () => {
                void openNote({ scope: note.scope, category: note.category, name: note.name });
            });
            item.append(button);
            if (note.summary !== null) {
                const summary = document.createElement("div");
                summary.className = "description";
                summary.innerHTML = renderMarkdown(note.summary);
                item.append(summary);
            }
            return item;
        }));
    }
    catch (err) {
        showStatus(notesStatus, errorMessage(err), true);
    }
}
async function openNote(note) {
    try {
        const { text } = await notesApi({ action: "read", ...note });
        setEditing(note, text);
        notesStatus.hidden = true;
    }
    catch (err) {
        showStatus(notesStatus, errorMessage(err), true);
    }
}
function newNote() {
    setEditing(null, NEW_NOTE_TEXT);
    notesStatus.hidden = true;
}
notesNew.addEventListener("click", newNote);
// Choosing a profile sends /profile through the chat, the same as typing it, so the reply and the instructions take
// the same path as any command.
profilePicker.addEventListener("change", () => {
    const ref = profilePicker.value;
    profilePicker.value = "";
    if (ref === "" || input.disabled) {
        return;
    }
    input.value = `/profile ${ref}`;
    form.requestSubmit();
});
noteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = editing ?? { scope: noteScope.value, category: noteCategory.value, name: noteName.value };
    try {
        const { message } = await notesApi({
            action: editing === null ? "create" : "update",
            ...note,
            content: noteContent.value,
        });
        setEditing(note, noteContent.value);
        showStatus(notesStatus, message, false);
        await refreshNotes();
    }
    catch (err) {
        showStatus(notesStatus, errorMessage(err), true);
    }
});
noteDelete.addEventListener("click", async () => {
    if (editing === null || !window.confirm(`Delete ${editing.scope} ${editing.category}/${editing.name}?`)) {
        return;
    }
    try {
        const { message } = await notesApi({ action: "delete", ...editing });
        newNote();
        showStatus(notesStatus, message, false);
        await refreshNotes();
    }
    catch (err) {
        showStatus(notesStatus, errorMessage(err), true);
    }
});
void refreshNotes();
void refreshSessions();
void refreshFiles();
void applyDefaultProfile();
// A narrower window clamps the shown width without changing the chosen one, and nothing is saved here.
window.addEventListener("resize", () => {
    if (toolsWidth > 0) {
        applyToolsWidth();
    }
});
