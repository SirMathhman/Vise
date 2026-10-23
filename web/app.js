"use strict";
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

"use strict";
// Helpers shared by the chat, the side panels and the file viewers.
// The text of a thrown value, as it is shown to the user.
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
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
// Shows a message in one of the side panel's status lines. An error is shown as an error.
function showStatus(status, message, isError) {
    status.textContent = message;
    status.className = isError ? "error" : "summary";
    status.hidden = false;
}

"use strict";
// The tabs of the chat page: the open chats and the open files share one row above the chat. Each tab is a name and a
// close button. Each kind keeps its own shown item, so the shown chat and the shown file are both marked.
// Adds a tab to a group of the row. Choosing its name calls onSelect, and its close button calls onClose.
function createTab(group, label, onSelect, onClose) {
    const tab = document.createElement("div");
    tab.className = "tab-wrap";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "tab";
    name.textContent = label;
    name.addEventListener("click", onSelect);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", onClose);
    tab.append(name, close);
    group.append(tab);
    return tab;
}
// Marks a tab as the shown one of its kind.
function setTabActive(tab, shown) {
    tab.classList.toggle("active", shown);
}

"use strict";
// The open chats: each one's history, log and tab, and the streaming of a reply into its log. The chat form itself is
// wired in app.ts.
// The error, with the tool calls that ran before it: their effects remain even though the turn did not finish.
function describeFailure(error, ran) {
    if (!ran || ran.length === 0) {
        return error;
    }
    return `${error} ${ran.length} tool call(s) ran before this, and their effects remain: ${ran.join("; ")}`;
}
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
const logHost = document.getElementById("log");
const chatTabs = document.getElementById("chat-tabs");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const stopButton = document.getElementById("stop");
const chats = [];
// The chat shown in the page. Every chat is shown in turn, so this is always set once the page has started.
let active;
let chatCount = 0;
// Creates a chat with its own log and tab. It is not shown until showChat is called. Closing its tab calls onClose.
function createChat(onClose) {
    const log = document.createElement("div");
    log.className = "chat-log";
    log.hidden = true;
    logHost.append(log);
    chatCount += 1;
    const tab = createTab(chatTabs, `Chat ${chatCount}`, () => showChat(chat), () => onClose(chat));
    const chat = {
        conversation: [],
        told: [],
        autosaveName: null,
        log,
        tab,
        inFlight: null,
        busy: false,
        closed: false,
        defaultProfile: Promise.resolve(),
        defaultAbort: null,
    };
    chats.push(chat);
    return chat;
}
// Shows one chat in the chat's space: its log and tab are the ones shown, and the form follows its reply. A file that
// was shown in that space is put away.
function showChat(chat) {
    active = chat;
    for (const other of chats) {
        other.log.hidden = other !== chat;
        setTabActive(other.tab, other === chat);
    }
    hideFiles();
    refreshForm();
    scrollToEnd(chat);
    saveChats();
}
// The form follows the shown chat: it is off while that chat's reply is pending, and Stop shows while it is streaming.
function refreshForm() {
    input.disabled = active.busy;
    sendButton.hidden = active.inFlight !== null;
    stopButton.hidden = active.inFlight === null;
}
// The open chats and which one is shown, kept in this browser so a reload brings them back. Storage can be blocked, in
// which case the chats last for this page load only.
const CHATS_KEY = "vise-chats";
function saveChats() {
    try {
        localStorage.setItem(CHATS_KEY, JSON.stringify({ names: chats.map((chat) => chat.autosaveName), active: chats.indexOf(active) }));
    }
    catch {
        // Not saved: the chats last for this page load only.
    }
}
function addEntry(chat, kind) {
    const entry = document.createElement("div");
    entry.className = kind;
    chat.log.appendChild(entry);
    return entry;
}
// Keeps the end of a chat in view, when that chat is the one shown.
function scrollToEnd(chat) {
    if (chat === active) {
        logHost.scrollTop = logHost.scrollHeight;
    }
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
async function streamChat(messages, told, onEvent, signal) {
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

"use strict";
// The Tools panel: the tools this tab uses, each switched on or off on the server.
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

"use strict";
// The default profile: the instructions a chat starts with, requested when the chat is opened.
// Starts a chat with the built-in default profile. The server applies its tools and returns its instructions, if it has
// any, which join that chat's conversation. Nothing is shown in its log. The chat's first message waits for this.
function applyDefaultProfile(chat) {
    const controller = new AbortController();
    chat.defaultAbort = controller;
    chat.defaultProfile = (async () => {
        try {
            const done = await streamChat([{ role: "user", content: "/profile default" }], chat.told, () => { }, controller.signal);
            if (done.profile != null) {
                chat.conversation.push({ role: "profile", content: done.profile });
            }
        }
        catch (err) {
            if (!controller.signal.aborted) {
                addEntry(chat, "error").textContent = errorMessage(err);
            }
        }
        void refreshTools();
    })();
    return chat.defaultProfile;
}

"use strict";
// The widths of the side panels: each divider sets its panel, and the window decides how much room each one gets.
const MIN_TOOLS_PX = 160;
// The chat's preferred width, 24rem. The panels leave it this much when they can, and it gives way in a narrow window.
const CHAT_PX = 384;
const layout = document.querySelector(".layout");
const main = document.querySelector("main");
const toolsPanel = {
    panel: document.querySelector("aside"),
    divider: document.getElementById("divider"),
    cssVar: "--tools-width",
    storageKey: "vise-tools-width",
    min: MIN_TOOLS_PX,
    direction: -1,
    chosen: 0,
};
// The most a panel may take: the window less the chat's preferred width and every other panel as it is now shown. A
// panel still gets its own minimum when the window is too narrow, and the chat gives way instead.
function roomFor(resizable) {
    let others = 0;
    for (const child of Array.from(layout.children)) {
        if (child !== main && child !== resizable.panel) {
            others += child.offsetWidth;
        }
    }
    return layout.clientWidth - others - CHAT_PX;
}
// Sets the chosen width to what fits.
function applyPanelWidths() {
    for (const resizable of [toolsPanel]) {
        if (resizable.chosen > 0) {
            const px = Math.max(resizable.min, Math.min(resizable.chosen, roomFor(resizable)));
            document.documentElement.style.setProperty(resizable.cssVar, `${px}px`);
        }
    }
}
// Dragging a divider sets its panel's width. The width follows the pointer from where the drag began.
function watchDivider(resizable) {
    let drag = null;
    resizable.divider.addEventListener("pointerdown", (event) => {
        drag = { x: event.clientX, width: resizable.panel.getBoundingClientRect().width };
        resizable.divider.setPointerCapture(event.pointerId);
        event.preventDefault();
    });
    resizable.divider.addEventListener("pointermove", (event) => {
        if (drag !== null) {
            resizable.chosen = drag.width + resizable.direction * (event.clientX - drag.x);
            applyPanelWidths();
        }
    });
    function endDrag() {
        if (drag === null) {
            return;
        }
        drag = null;
        try {
            localStorage.setItem(resizable.storageKey, String(resizable.chosen));
        }
        catch {
            // Not saved: the width lasts for this page load only.
        }
    }
    resizable.divider.addEventListener("pointerup", endDrag);
    resizable.divider.addEventListener("pointercancel", endDrag);
}
// Restores the width this browser last used. Storage can be blocked, in which case the default width is used.
for (const resizable of [toolsPanel]) {
    try {
        const stored = Number(localStorage.getItem(resizable.storageKey));
        if (stored > 0) {
            resizable.chosen = stored;
        }
    }
    catch {
        // The default width stays.
    }
    watchDivider(resizable);
}
applyPanelWidths();

"use strict";
// The open files. One file at a time takes the chat's space, in place of the chat log, and the tabs of the open files
// share the row above the chat. The blocks of each file arrive as they are loaded.
const fileTabs = document.getElementById("file-tabs");
const viewersBody = document.getElementById("viewers-body");
const viewersCloseAll = document.getElementById("viewers-close-all");
const viewed = [];
let activePath = null;
// The open files and the one shown, kept in this browser so a reload brings them back. Storage can be blocked, in which
// case the files last for this page load only.
const FILES_KEY = "vise-files";
function saveFiles() {
    try {
        localStorage.setItem(FILES_KEY, JSON.stringify({ paths: viewed.map((file) => file.path), active: activePath }));
    }
    catch {
        // Not saved: the files last for this page load only.
    }
}
function readSavedFiles() {
    try {
        const saved = JSON.parse(localStorage.getItem(FILES_KEY) ?? "null");
        return saved !== null && Array.isArray(saved.paths) ? saved : null;
    }
    catch {
        // Unreadable or blocked storage: no files are open.
        return null;
    }
}
// The files open at the last visit, read as the page loads. Startup shows the chat, which saves the file list, so it is
// read here, before anything can overwrite it.
const savedFiles = readSavedFiles();
// Whether a file is markdown, which opens rendered and can be switched to its raw text.
function isMarkdown(path) {
    return path.toLowerCase().endsWith(".md");
}
function renderViewers() {
    viewersCloseAll.hidden = viewed.length === 0;
    for (const file of viewed) {
        setTabActive(file.tab, file.path === activePath);
    }
    viewersBody.hidden = activePath === null;
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
    head.append(name);
    if (isMarkdown(file.path)) {
        head.append(rendererToggle(file));
    }
    const text = fileBody(file);
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
    // A rendered file loads its blocks by itself, so Load more is only offered to retry a block that failed.
    if (file.more && (!file.rendered || file.error !== null)) {
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
    // A rendered file waits for every block, so it is rendered from its whole text. A failed block stops this, and Load more tries it again.
    if (file.rendered && file.more && file.error === null) {
        void loadBlock(path);
    }
    else if (file.rendered && file.path === activePath) {
        renderViewers();
    }
}
// The file's text: the raw lines, or the markdown rendered from the whole file once every block has loaded.
function fileBody(file) {
    if (!file.rendered) {
        const pre = document.createElement("pre");
        // The text is set as plain text, so nothing in it is read as HTML.
        pre.textContent = file.lines.join("\n");
        return pre;
    }
    const rendered = document.createElement("div");
    rendered.className = "markdown";
    if (file.loading) {
        rendered.textContent = "Loading…";
    }
    else if (file.more) {
        rendered.textContent = "The rest of the file has not loaded.";
    }
    else {
        rendered.innerHTML = renderMarkdown(file.lines.join("\n"));
    }
    return rendered;
}
// Switches a file between its rendered markdown and its raw text. Showing it rendered loads the blocks it still lacks.
function rendererToggle(file) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = file.rendered ? "Raw" : "Rendered";
    toggle.addEventListener("click", () => {
        file.rendered = !file.rendered;
        if (file.rendered && file.more && !file.loading && file.error === null) {
            void loadBlock(file.path);
        }
        renderViewers();
    });
    return toggle;
}
// Shows a file in the chat's space, in place of the chat log. The chat tabs stop being marked as shown.
function selectFile(path) {
    activePath = path;
    for (const chat of chats) {
        chat.log.hidden = true;
        setTabActive(chat.tab, false);
    }
    saveFiles();
    renderViewers();
}
// Puts the shown file away, so the chat's space is free for the chat. Called when a chat is shown.
function hideFiles() {
    activePath = null;
    saveFiles();
    renderViewers();
}
// Opens a file as a tab and makes it the one shown. Opening a file that is already open only shows its tab.
function openFile(path) {
    if (!viewed.some((file) => file.path === path)) {
        const tab = createTab(fileTabs, path, () => selectFile(path), () => closeFile(path));
        viewed.push({ path, lines: [], next: 0, more: false, loading: false, error: null, rendered: isMarkdown(path), tab });
        void loadBlock(path);
    }
    selectFile(path);
}
// Closes one file. When it was the one shown, the file opened last takes its place.
function closeFile(path) {
    const index = viewed.findIndex((file) => file.path === path);
    if (index === -1) {
        return;
    }
    viewed[index].tab.remove();
    viewed.splice(index, 1);
    if (activePath !== path) {
        saveFiles();
        renderViewers();
    }
    else if (viewed.length > 0) {
        // The file opened last takes the place of the one closed.
        selectFile(viewed[viewed.length - 1].path);
    }
    else {
        // With no file left open, the chat is shown again.
        showChat(active);
    }
}
viewersCloseAll.addEventListener("click", () => {
    for (const file of viewed) {
        file.tab.remove();
    }
    viewed.length = 0;
    showChat(active);
});
// Opens the files that were open at the last visit, and shows the one that was shown then. A file that is no longer
// there shows its error in its viewer.
function restoreFiles() {
    if (savedFiles === null) {
        return;
    }
    const shown = savedFiles.active;
    for (const path of savedFiles.paths) {
        openFile(path);
    }
    if (shown !== null && viewed.some((file) => file.path === shown)) {
        selectFile(shown);
    }
    else {
        showChat(active);
    }
}

"use strict";
// The Sessions panel: saved conversations, and the autosave after each completed turn of each open chat.
// Saved sessions in the side panel. The server writes and reads the files; loading replaces the shown chat's conversation
// both on screen and in the history the next request sends.
const sessionForm = document.getElementById("session-form");
const sessionName = document.getElementById("session-name");
const sessionsList = document.getElementById("sessions-list");
const sessionsStatus = document.getElementById("sessions-status");
async function refreshSessions() {
    try {
        const { sessions } = await postJson("/api/sessions", {
            action: "list",
        });
        sessionsList.replaceChildren(...sessions.map(({ name, title }) => {
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            // A session without a title shows its name.
            button.textContent = title ?? name;
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
// Adds one saved message to a chat's log the way the live conversation showed it. Profile instructions are not shown.
function showMessage(chat, message) {
    if (message.role === "user") {
        addEntry(chat, "user").textContent = message.content;
    }
    else if (message.role === "assistant") {
        const bubble = addEntry(chat, "assistant");
        const answer = markdownBlock();
        answer.innerHTML = renderMarkdown(message.content);
        bubble.append(answer);
    }
    else if (message.role === "summary") {
        addEntry(chat, "summary").textContent = "Earlier conversation summarized.";
    }
    else if (message.role === "summary_failed") {
        addEntry(chat, "summary").textContent = "Could not summarize the conversation. It will be tried again later.";
    }
}
sessionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = sessionName.value.trim();
    if (name === "") {
        return;
    }
    const chat = active;
    // A reply in flight is not part of the conversation yet, so the save waits for it.
    if (chat.busy) {
        showStatus(sessionsStatus, "Wait for the reply to finish, then save.", true);
        return;
    }
    try {
        const { message } = await postJson("/api/sessions", {
            action: "save",
            name,
            messages: chat.conversation,
            told: chat.told,
        });
        sessionName.value = "";
        showStatus(sessionsStatus, message, false);
        await refreshSessions();
    }
    catch (err) {
        showStatus(sessionsStatus, errorMessage(err), true);
    }
});
// Saves a chat's conversation after a completed turn. The save runs in the background: a failure shows in the Sessions
// panel, and the chat is unaffected. The chat's name is picked at its first save, so later turns update the same session.
// After the first turn, the session is also given a title, asked of the model from that first exchange.
function autosaveTurn(chat) {
    if (chat.autosaveName === null) {
        chat.autosaveName = `auto-${Date.now()}`;
        saveChats();
    }
    const name = chat.autosaveName;
    const firstTurn = chat.conversation.filter((message) => message.role === "user").length === 1;
    const exchange = chat.conversation.filter((message) => message.role === "user" || message.role === "assistant").slice(0, 2);
    postJson("/api/sessions", {
        action: "save",
        name,
        messages: chat.conversation,
        told: chat.told,
    })
        .then(async () => {
        if (firstTurn) {
            await postJson("/api/sessions", { action: "title", name, messages: exchange });
        }
    })
        .then(() => refreshSessions(), (err) => showStatus(sessionsStatus, errorMessage(err), true));
}
// Fills a chat from a saved session: its conversation and switches are replaced, and its log shows the saved messages.
async function loadInto(chat, name) {
    const data = await postJson("/api/sessions", { action: "load", name });
    // The default profile must land before the loaded conversation, or it could join the conversation after it.
    await chat.defaultProfile;
    chat.conversation.length = 0;
    chat.conversation.push(...data.messages);
    chat.told = data.told;
    chat.log.replaceChildren();
    data.messages.forEach((message) => showMessage(chat, message));
    scrollToEnd(chat);
}
// Loads a saved session into the shown chat. The next turn starts a new saved session, as it did before chats were tabs.
async function loadSession(name) {
    const chat = active;
    showChat(chat);
    if (chat.busy) {
        showStatus(sessionsStatus, "Wait for the reply to finish, then load.", true);
        return;
    }
    // Input stays off while the session loads, so a message cannot slip in between the request and the replacement.
    chat.busy = true;
    refreshForm();
    try {
        await loadInto(chat, name);
        chat.autosaveName = null;
        saveChats();
        showStatus(sessionsStatus, `Loaded session ${name}.`, false);
    }
    catch (err) {
        showStatus(sessionsStatus, errorMessage(err), true);
    }
    finally {
        chat.busy = false;
        refreshForm();
        input.focus();
    }
}

"use strict";
// The Files panel: the working directory's tree, and the refresh button.
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

"use strict";
// The Notes panel: the notes list, the editor for one note, and the profile picker.
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

"use strict";
// The Workflows panel: the saved workflows, and an editor for one. Each step is picked by type, and only the fields for
// that type are shown, so a workflow is built from fields rather than typed as JSON. The server checks a workflow again
// on save, and the editor checks the obvious mistakes first, so each one is shown beside the step that has it.
const workflowsList = document.getElementById("workflows-list");
const workflowsStatus = document.getElementById("workflows-status");
const workflowNew = document.getElementById("workflow-new");
const workflowForm = document.getElementById("workflow-form");
const workflowName = document.getElementById("workflow-name");
const workflowSteps = document.getElementById("workflow-steps");
const workflowRun = document.getElementById("workflow-run");
const workflowDelete = document.getElementById("workflow-delete");
const workflowAddInstructions = document.getElementById("workflow-add-instructions");
const workflowAddProfile = document.getElementById("workflow-add-profile");
const workflowAddTool = document.getElementById("workflow-add-tool");
// The tools and profiles the editor offers, as the server lists them on refresh.
let workflowTools = [];
let workflowProfiles = [];
// The workflow open in the editor, by name. Null while a new one is written.
let workflowEditing = null;
let workflowDraft = [];
// Reloads the list of workflows, and the tools and profiles the editor offers. An open editor keeps what is in it.
async function refreshWorkflows() {
    try {
        const [{ workflows, tools }, { notes }] = await Promise.all([
            postJson("/api/workflows", { action: "list" }),
            postJson("/api/notes", { action: "profiles" }),
        ]);
        workflowTools = tools;
        workflowProfiles = notes.map((note) => `${note.scope}/${note.category}/${note.name}`);
        workflowsList.replaceChildren(...workflows.map((name) => {
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = name;
            button.addEventListener("click", () => {
                void openWorkflow(name);
            });
            item.append(button);
            return item;
        }));
    }
    catch (err) {
        showStatus(workflowsStatus, errorMessage(err), true);
    }
}
// Opens a saved workflow in the editor.
async function openWorkflow(name) {
    try {
        const { steps } = await postJson("/api/workflows", { action: "load", name });
        workflowEditing = name;
        workflowDraft = steps.map(fromJsonStep);
        showWorkflowEditor(true);
    }
    catch (err) {
        showStatus(workflowsStatus, errorMessage(err), true);
    }
}
// Shows the editor, or hides it, and fills it from the draft. A saved workflow's name cannot be changed here.
function showWorkflowEditor(open) {
    workflowForm.hidden = !open;
    workflowName.value = workflowEditing ?? workflowName.value;
    workflowName.disabled = workflowEditing !== null;
    workflowRun.hidden = workflowEditing === null;
    workflowDelete.hidden = workflowEditing === null;
    renderWorkflowSteps();
}
function fromJsonStep(step) {
    if (typeof step.instructions === "string") {
        return { type: "instructions", text: step.instructions };
    }
    if (typeof step.profile === "string") {
        return { type: "profile", reference: step.profile };
    }
    const args = (step.arguments ?? null);
    return {
        type: "tool",
        name: String(step.tool),
        fixed: args !== null,
        args: Object.entries(args ?? {}).map(([key, value]) => ({
            key,
            value: typeof value === "string" ? value : JSON.stringify(value),
        })),
    };
}
function toJsonStep(step) {
    if (step.type === "instructions") {
        return { instructions: step.text };
    }
    if (step.type === "profile") {
        return { profile: step.reference };
    }
    if (!step.fixed) {
        return { tool: step.name };
    }
    // Every argument is sent as the text typed. The server reads each one as its tool's parameter type.
    return { tool: step.name, arguments: Object.fromEntries(step.args.map((arg) => [arg.key, arg.value])) };
}
// The first problem with the workflow as it stands, or null when it can be saved.
function workflowProblem(name) {
    if (name === "") {
        return "Give the workflow a name.";
    }
    if (workflowDraft.length === 0) {
        return "Add at least one step.";
    }
    for (const [index, step] of workflowDraft.entries()) {
        const where = `Step ${index + 1}`;
        if (step.type === "instructions" && step.text.trim() === "") {
            return `${where} needs instructions.`;
        }
        if (step.type === "profile" && step.reference === "") {
            return `${where} needs a profile.`;
        }
        if (step.type === "tool" && step.name === "") {
            return `${where} needs a tool.`;
        }
        if (step.type === "tool" && step.fixed) {
            const keys = step.args.map((arg) => arg.key.trim());
            if (keys.includes("")) {
                return `${where} has an argument with no name.`;
            }
            if (new Set(keys).size !== keys.length) {
                return `${where} names an argument twice.`;
            }
        }
    }
    return null;
}
function renderWorkflowSteps() {
    workflowSteps.replaceChildren(...workflowDraft.map((step, index) => workflowStepItem(step, index)));
}
// Adds a button that does one thing to a step, and is shown with the given text.
function stepButton(text, disabled, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
}
// One step in the editor: its type, its move and remove buttons, and the fields for its type.
function workflowStepItem(step, index) {
    const item = document.createElement("li");
    const head = document.createElement("div");
    head.className = "step-head";
    const label = document.createElement("strong");
    label.textContent = step.type === "instructions" ? "Instructions" : step.type === "profile" ? "Profile" : "Tool";
    const move = (to) => () => {
        [workflowDraft[index], workflowDraft[to]] = [workflowDraft[to], workflowDraft[index]];
        renderWorkflowSteps();
    };
    head.append(label, stepButton("Up", index === 0, move(index - 1)), stepButton("Down", index === workflowDraft.length - 1, move(index + 1)), stepButton("Remove", false, () => {
        workflowDraft.splice(index, 1);
        renderWorkflowSteps();
    }));
    item.append(head);
    if (step.type === "instructions") {
        const text = document.createElement("textarea");
        text.rows = 3;
        text.value = step.text;
        text.setAttribute("aria-label", `Step ${index + 1} instructions`);
        text.addEventListener("input", () => {
            step.text = text.value;
        });
        const hint = document.createElement("p");
        hint.className = "description";
        hint.textContent = "{argument} is replaced by the argument typed after the workflow's name.";
        item.append(text, hint);
    }
    else if (step.type === "profile") {
        item.append(profileSelect(step, index));
    }
    else {
        item.append(toolFields(step, index));
    }
    return item;
}
function profileSelect(step, index) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Step ${index + 1} profile`);
    const choices = ["default", ...workflowProfiles.filter((reference) => reference !== "default")];
    if (step.reference !== "" && !choices.includes(step.reference)) {
        // A profile that has since been removed stays shown, so the user can see what the step names.
        choices.push(step.reference);
    }
    select.append(new Option("Choose a profile…", ""));
    for (const reference of choices) {
        select.append(new Option(reference, reference, false, reference === step.reference));
    }
    select.addEventListener("change", () => {
        step.reference = select.value;
    });
    return select;
}
// A tool step's fields: the tool, whether the model supplies the arguments, and the fixed arguments when it does not.
function toolFields(step, index) {
    const fields = document.createElement("div");
    const tool = document.createElement("select");
    tool.setAttribute("aria-label", `Step ${index + 1} tool`);
    tool.append(new Option("Choose a tool…", ""));
    for (const name of workflowTools) {
        tool.append(new Option(name, name, false, name === step.name));
    }
    tool.addEventListener("change", () => {
        step.name = tool.value;
    });
    const mode = document.createElement("select");
    mode.setAttribute("aria-label", `Step ${index + 1} arguments`);
    mode.append(new Option("Model supplies", "model", false, !step.fixed));
    mode.append(new Option("Fixed arguments", "fixed", false, step.fixed));
    mode.addEventListener("change", () => {
        step.fixed = mode.value === "fixed";
        renderWorkflowSteps();
    });
    fields.append(tool, mode);
    if (step.fixed) {
        fields.append(fixedArguments(step, index));
    }
    return fields;
}
// The fixed arguments of a tool step, one name and value per row.
function fixedArguments(step, index) {
    const list = document.createElement("div");
    list.className = "workflow-args";
    step.args.forEach((arg, row) => {
        const line = document.createElement("div");
        const key = document.createElement("input");
        key.placeholder = "name";
        key.value = arg.key;
        key.setAttribute("aria-label", `Step ${index + 1} argument ${row + 1} name`);
        key.addEventListener("input", () => {
            arg.key = key.value;
        });
        const value = document.createElement("input");
        value.placeholder = "value";
        value.value = arg.value;
        value.setAttribute("aria-label", `Step ${index + 1} argument ${row + 1} value`);
        value.addEventListener("input", () => {
            arg.value = value.value;
        });
        const remove = stepButton("Remove", false, () => {
            step.args.splice(row, 1);
            renderWorkflowSteps();
        });
        line.append(key, value, remove);
        list.append(line);
    });
    const add = stepButton("Add argument", false, () => {
        step.args.push({ key: "", value: "" });
        renderWorkflowSteps();
    });
    const hint = document.createElement("p");
    hint.className = "description";
    hint.textContent = "Each value is read as the tool's parameter: a number, true or false where it takes one, otherwise text.";
    list.append(add, hint);
    return list;
}
workflowNew.addEventListener("click", () => {
    workflowEditing = null;
    workflowDraft = [];
    workflowName.value = "";
    showWorkflowEditor(true);
});
workflowAddInstructions.addEventListener("click", () => {
    workflowDraft.push({ type: "instructions", text: "" });
    renderWorkflowSteps();
});
workflowAddProfile.addEventListener("click", () => {
    workflowDraft.push({ type: "profile", reference: "" });
    renderWorkflowSteps();
});
workflowAddTool.addEventListener("click", () => {
    workflowDraft.push({ type: "tool", name: "", fixed: false, args: [] });
    renderWorkflowSteps();
});
workflowForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = workflowEditing ?? workflowName.value.trim();
    const problem = workflowProblem(name);
    if (problem !== null) {
        showStatus(workflowsStatus, problem, true);
        return;
    }
    try {
        const { message } = await postJson("/api/workflows", {
            action: "save",
            name,
            steps: workflowDraft.map(toJsonStep),
        });
        workflowEditing = name;
        showWorkflowEditor(true);
        showStatus(workflowsStatus, message, false);
        await refreshWorkflows();
    }
    catch (err) {
        showStatus(workflowsStatus, errorMessage(err), true);
    }
});
// Puts the workflow's name in the chat's input, so its argument can be typed after it and sent.
workflowRun.addEventListener("click", () => {
    if (workflowEditing !== null) {
        input.value = `/${workflowEditing} `;
        input.focus();
    }
});
workflowDelete.addEventListener("click", async () => {
    if (workflowEditing === null || !confirm(`Delete workflow ${workflowEditing}?`)) {
        return;
    }
    try {
        const { message } = await postJson("/api/workflows", { action: "delete", name: workflowEditing });
        workflowEditing = null;
        workflowDraft = [];
        showWorkflowEditor(false);
        showStatus(workflowsStatus, message, false);
        await refreshWorkflows();
    }
    catch (err) {
        showStatus(workflowsStatus, errorMessage(err), true);
    }
});

"use strict";
// The chat page: wires the chat form, its buttons and the chat tabs to the chats, and starts each panel.
const newButton = document.getElementById("new");
// Adds the assistant's bubble to the chat's log, with its Thinking block hidden until reasoning arrives.
function startReply(chat) {
    const bubble = addEntry(chat, "assistant");
    const thinking = document.createElement("details");
    thinking.className = "thinking";
    thinking.open = true;
    thinking.hidden = true;
    const thinkingSummary = document.createElement("summary");
    thinkingSummary.textContent = "Thinking";
    const thinkingText = document.createElement("div");
    thinking.append(thinkingSummary, thinkingText);
    const answerText = markdownBlock();
    bubble.append(thinking, answerText);
    return { chat, bubble, thinking, thinkingText, reasoningDone: false, answerText, answerRaw: "", subagent: null };
}
// Folds the Thinking block away once the reasoning is over. It can be opened again from its summary.
function finishReasoning(reply) {
    if (!reply.reasoningDone) {
        reply.reasoningDone = true;
        reply.thinking.open = false;
    }
}
// Starts the next step of a workflow: a line that names the step, and a new reply under it. The reply before it is
// removed if nothing was shown in it.
function stepReply(chat, previous, text) {
    finishReasoning(previous);
    if (previous.bubble.textContent === "") {
        previous.bubble.remove();
    }
    addEntry(chat, "summary").textContent = text;
    return startReply(chat);
}
// Shows one streamed piece of the reply in its place in the bubble.
function showStreamed(reply, streamed) {
    if (streamed.type !== "reasoning") {
        // The answer or a tool call only starts after the reasoning has ended.
        finishReasoning(reply);
    }
    if (streamed.type === "reasoning") {
        if (reply.reasoningDone) {
            // Reasoning after a tool round opens the block again, so it is seen. It folds again when the next round starts.
            reply.reasoningDone = false;
            reply.thinking.open = true;
        }
        reply.thinking.hidden = false;
        reply.thinkingText.textContent += streamed.text;
    }
    else if (streamed.type === "content") {
        reply.answerRaw += streamed.text;
        reply.answerText.innerHTML = renderMarkdown(reply.answerRaw);
    }
    else if (streamed.type === "tool") {
        // Text after a tool call goes in a new block below it, so the order matches the stream.
        reply.answerText = markdownBlock();
        reply.answerRaw = "";
        reply.bubble.append(toolLine(streamed.text), reply.answerText);
    }
    else if (streamed.type === "subagent_start") {
        reply.subagent = openSubagent(reply.bubble, streamed);
    }
    else if (streamed.type === "nested") {
        if (reply.subagent !== null) {
            renderSubagentStep(reply.subagent, streamed.event);
        }
    }
    else if (streamed.type === "subagent_end") {
        if (reply.subagent !== null) {
            closeSubagent(reply.subagent, streamed.failed);
        }
        reply.subagent = null;
        // Text after a subagent goes in a new block below it, as text after a tool call does.
        reply.answerText = markdownBlock();
        reply.answerRaw = "";
        reply.bubble.append(reply.answerText);
    }
    scrollToEnd(reply.chat);
}
// Keeps a finished reply. Its profile joins the conversation, and a turn that is not a tool command is kept and saved.
function keepReply(chat, done, command) {
    if (done.profile != null) {
        // A chosen profile's instructions join the conversation, so the later requests keep following them.
        chat.conversation.push({ role: "profile", content: done.profile });
    }
    if (!command) {
        if (done.workflow != null) {
            // A workflow's messages take the place of the command line it was sent as.
            chat.conversation.pop();
            chat.conversation.push(...done.workflow);
        }
        else {
            // The server may have added a note about switch changes to this user message. The note and the record of switches
            // the model now knows about are kept only once the reply has arrived.
            if (done.user_message != null) {
                chat.conversation[chat.conversation.length - 1].content = done.user_message;
            }
            chat.conversation.push({ role: "assistant", content: done.answer });
        }
        if (done.told) {
            chat.told = done.told;
        }
        // A summary is appended after the reply. The earlier messages stay in the log, unchanged.
        if (done.summary != null) {
            chat.conversation.push({ role: "summary", content: done.summary });
            addEntry(chat, "summary").textContent = "Earlier conversation summarized.";
        }
        else if (done.summary_failed != null) {
            chat.conversation.push({ role: "summary_failed", content: done.summary_failed });
            addEntry(chat, "summary").textContent = "Could not summarize the conversation. It will be tried again later.";
        }
        autosaveTurn(chat);
    }
}
// A reply that failed or was stopped. Its turn is not kept, and a failure shows its reason.
function failReply(reply, err, command) {
    const { chat } = reply;
    if (!command) {
        chat.conversation.pop();
    }
    if (chat.inFlight?.signal.aborted) {
        // Stopped by the user: what streamed stays on screen, but the turn is not kept, as a failed one is not.
        addEntry(chat, "summary").textContent =
            "Stopped. Tool calls shown above may already have run, and their effects remain. This turn was not kept in the conversation.";
    }
    else {
        if (reply.answerText.textContent === "" && reply.thinkingText.textContent === "") {
            reply.bubble.remove();
        }
        addEntry(chat, "error").textContent = errorMessage(err);
    }
}
// Ends a chat's turn, whatever its outcome. The form follows the shown chat, so it is only re-set when that is this one.
function endTurn(chat) {
    chat.inFlight = null;
    chat.busy = false;
    refreshForm();
    if (chat === active) {
        input.focus();
    }
    // A typed /enable or /disable changes a switch on the server, so the panel is redrawn from it.
    void refreshTools();
    scrollToEnd(chat);
}
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === "") {
        return;
    }
    // The turn belongs to the chat shown when it was sent, even if another chat is shown by the time it ends. Sending
    // shows that chat, in case a file was shown in its place.
    const chat = active;
    showChat(chat);
    chat.busy = true;
    refreshForm();
    input.value = "";
    // The default profile must be in place before the user's message joins the conversation.
    await chat.defaultProfile;
    // A chat closed while its profile was loading is not continued, so nothing is sent or saved for it.
    if (chat.closed) {
        endTurn(chat);
        return;
    }
    // Tool commands are answered by the server and kept out of the conversation.
    const command = /^\/(tools|enable|disable|notes|profile)(\s|$)/.test(text);
    if (!command) {
        chat.conversation.push({ role: "user", content: text });
    }
    addEntry(chat, "user").textContent = text;
    let reply = startReply(chat);
    try {
        const messages = command ? [...chat.conversation, { role: "user", content: text }] : chat.conversation;
        const controller = new AbortController();
        chat.inFlight = controller;
        refreshForm();
        const done = await streamChat(messages, chat.told, (streamed) => {
            if (streamed.type === "step") {
                reply = stepReply(chat, reply, streamed.text);
            }
            else {
                showStreamed(reply, streamed);
            }
        }, controller.signal);
        finishReasoning(reply);
        keepReply(chat, done, command);
    }
    catch (err) {
        failReply(reply, err, command);
    }
    finally {
        endTurn(chat);
    }
});
stopButton.addEventListener("click", () => {
    active.inFlight?.abort();
    active.defaultAbort?.abort();
});
// Opens a new chat with the default profile and shows it. The chats already open are kept.
function newChat() {
    const chat = createChat(closeChat);
    showChat(chat);
    void applyDefaultProfile(chat);
}
// Closes a chat. A reply still running in it is stopped. Closing the last chat opens a new one in its place.
function closeChat(chat) {
    chat.closed = true;
    chat.inFlight?.abort();
    chat.defaultAbort?.abort();
    const index = chats.indexOf(chat);
    chats.splice(index, 1);
    chat.log.remove();
    chat.tab.remove();
    if (chats.length === 0) {
        newChat();
    }
    else if (active === chat) {
        showChat(chats[Math.max(0, index - 1)]);
    }
    else {
        saveChats();
    }
}
// Brings back the chats open at the last visit, with the one that was shown. A chat that was saved comes back from its
// saved session. A chat that cannot be loaded starts empty, and its name is dropped so a reply cannot overwrite the file.
function restoreChats() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(CHATS_KEY) ?? "null");
    }
    catch {
        // Unreadable or blocked storage: the page starts with one chat.
    }
    if (saved === null || !Array.isArray(saved.names) || saved.names.length === 0) {
        newChat();
        return;
    }
    for (const name of saved.names) {
        const chat = createChat(closeChat);
        if (name === null) {
            void applyDefaultProfile(chat);
        }
        else {
            chat.autosaveName = name;
            chat.busy = true;
            void loadInto(chat, name).then(() => {
                chat.busy = false;
                refreshForm();
            }, (err) => {
                chat.autosaveName = null;
                chat.busy = false;
                addEntry(chat, "error").textContent = errorMessage(err);
                refreshForm();
            });
        }
    }
    showChat(chats[saved.active] ?? chats[0]);
}
newButton.addEventListener("click", newChat);
restoreChats();
restoreFiles();
void refreshTools();
void refreshNotes();
void refreshSessions();
void refreshWorkflows();
void refreshFiles();
// A narrower window clamps the shown width without changing the chosen one, and nothing is saved here.
window.addEventListener("resize", applyPanelWidths);
