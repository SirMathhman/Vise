"use strict";
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
        const line = document.createElement("div");
        line.className = "tool";
        line.textContent = `[tool] ${step.text}`;
        sub.block.append(line);
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
    let answerText = document.createElement("div");
    answerText.className = "markdown";
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
                const toolLine = document.createElement("div");
                toolLine.className = "tool";
                toolLine.textContent = `[tool] ${streamed.text}`;
                answerText = document.createElement("div");
                answerText.className = "markdown";
                answerRaw = "";
                bubble.append(toolLine, answerText);
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
                answerText = document.createElement("div");
                answerText.className = "markdown";
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
                addEntry("error").textContent = err instanceof Error ? err.message : String(err);
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
// Saved sessions in the side panel. The server writes and reads the files; loading replaces the conversation both on
// screen and in the history the next request sends.
const sessionForm = document.getElementById("session-form");
const sessionName = document.getElementById("session-name");
const sessionsList = document.getElementById("sessions-list");
const sessionsStatus = document.getElementById("sessions-status");
function showSessionsStatus(message, isError) {
    sessionsStatus.textContent = message;
    sessionsStatus.className = isError ? "error" : "summary";
    sessionsStatus.hidden = false;
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
        showSessionsStatus(err instanceof Error ? err.message : String(err), true);
    }
}
// Adds one saved message to the log the way the live conversation showed it. Profile instructions are not shown.
function showMessage(message) {
    if (message.role === "user") {
        addEntry("user").textContent = message.content;
    }
    else if (message.role === "assistant") {
        const bubble = addEntry("assistant");
        const answer = document.createElement("div");
        answer.className = "markdown";
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
        showSessionsStatus("Wait for the reply to finish, then save.", true);
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
        showSessionsStatus(message, false);
        await refreshSessions();
    }
    catch (err) {
        showSessionsStatus(err instanceof Error ? err.message : String(err), true);
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
    }).then(() => refreshSessions(), (err) => showSessionsStatus(err instanceof Error ? err.message : String(err), true));
}
async function loadSession(name) {
    if (input.disabled) {
        showSessionsStatus("Wait for the reply to finish, then load.", true);
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
        showSessionsStatus(`Loaded session ${name}.`, false);
        scrollToEnd();
    }
    catch (err) {
        showSessionsStatus(err instanceof Error ? err.message : String(err), true);
    }
    finally {
        input.disabled = false;
        input.focus();
    }
}
const filesTree = document.getElementById("files-tree");
const filesStatus = document.getElementById("files-status");
const filesRefresh = document.getElementById("files-refresh");
// `prefix` is the path of the folder these nodes sit in, relative to the working directory. A file's button opens it.
function treeList(nodes, prefix) {
    const list = document.createElement("ul");
    for (const node of nodes) {
        const item = document.createElement("li");
        if (node.dir) {
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = `${node.name}/`;
            details.append(summary, treeList(node.children ?? [], `${prefix}${node.name}/`));
            item.append(details);
        }
        else {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "file-link";
            button.textContent = node.name;
            const path = `${prefix}${node.name}`;
            button.addEventListener("click", () => {
                void openFile(path);
            });
            item.append(button);
        }
        list.append(item);
    }
    return list;
}
const fileView = document.getElementById("file-view");
const fileViewName = document.getElementById("file-view-name");
const fileViewText = document.getElementById("file-view-text");
const fileViewClose = document.getElementById("file-view-close");
// The latest file asked for. A response for an earlier click arrives late and is dropped, so the name and the text
// always belong to the same file.
let latestFile = 0;
// Shows a file's text under the tree. The text is set as plain text, so nothing in it is read as HTML.
async function openFile(path) {
    const request = ++latestFile;
    try {
        const data = await postJson("/api/file", { path });
        if (request !== latestFile) {
            return;
        }
        fileViewName.textContent = data.path;
        fileViewText.textContent = data.text;
        fileView.hidden = false;
    }
    catch (err) {
        if (request !== latestFile) {
            return;
        }
        filesStatus.textContent = err instanceof Error ? err.message : String(err);
        filesStatus.className = "error";
        filesStatus.hidden = false;
    }
}
fileViewClose.addEventListener("click", () => {
    fileView.hidden = true;
});
async function refreshFiles() {
    try {
        const res = await fetch("/api/files");
        const data = (await res.json().catch(() => ({})));
        if (!res.ok || data.children === undefined) {
            throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const title = document.createElement("p");
        title.className = "description";
        title.textContent = `${data.name}/`;
        filesTree.replaceChildren(title, treeList(data.children, ""));
        filesStatus.textContent = data.truncated ? "The tree is cut short: only the first entries are listed." : "";
        filesStatus.className = "summary";
        filesStatus.hidden = !data.truncated;
    }
    catch (err) {
        filesStatus.textContent = err instanceof Error ? err.message : String(err);
        filesStatus.className = "error";
        filesStatus.hidden = false;
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
function showNotesStatus(message, isError) {
    notesStatus.textContent = message;
    notesStatus.className = isError ? "error" : "summary";
    notesStatus.hidden = false;
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
        showNotesStatus(err instanceof Error ? err.message : String(err), true);
    }
}
async function openNote(note) {
    try {
        const { text } = await notesApi({ action: "read", ...note });
        setEditing(note, text);
        notesStatus.hidden = true;
    }
    catch (err) {
        showNotesStatus(err instanceof Error ? err.message : String(err), true);
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
        showNotesStatus(message, false);
        await refreshNotes();
    }
    catch (err) {
        showNotesStatus(err instanceof Error ? err.message : String(err), true);
    }
});
noteDelete.addEventListener("click", async () => {
    if (editing === null || !window.confirm(`Delete ${editing.scope} ${editing.category}/${editing.name}?`)) {
        return;
    }
    try {
        const { message } = await notesApi({ action: "delete", ...editing });
        newNote();
        showNotesStatus(message, false);
        await refreshNotes();
    }
    catch (err) {
        showNotesStatus(err instanceof Error ? err.message : String(err), true);
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
