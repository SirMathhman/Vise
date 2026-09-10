/**
 * Renders the page shell (heading + tree + file viewer) into the app element.
 */
export function renderApp(appEl) {
  appEl.innerHTML = `
  <main class="page">
    <h1>Files &amp; directories</h1>
    <div class="layout">
      <div id="tree" class="tree-container"></div>
      <div class="divider" data-target="tree" tabindex="0" role="separator" aria-orientation="vertical" aria-label="Resize tree column"></div>
      <div id="file-viewer" class="file-viewer">
        <div class="file-viewer-header"></div>
        <pre class="file-viewer-content"><code class="placeholder">Select a file to view</code></pre>
      </div>
      <div class="divider" data-target="chat" tabindex="0" role="separator" aria-orientation="vertical" aria-label="Resize chat column"></div>
      <section class="chat">
        <div class="chat-header">
          <h2>Ask the model</h2>
          <button
            id="chat-follow"
            class="chat-follow"
            type="button"
            aria-pressed="true"
            title="Automatically scroll to the latest message"
          >
            Follow
          </button>
        </div>
        <form id="chat-form" class="chat-form">
          <input
            id="chat-input"
            class="chat-input"
            type="text"
            placeholder="Type a message…"
            autocomplete="off"
          />
          <button type="submit" class="chat-send">Send</button>
        </form>
        <div id="chat-messages" class="chat-messages">
          <p class="chat-placeholder">Your conversation will appear here</p>
        </div>
      </section>
    </div>
  </main>
`;
}

/**
 * Renders a list of entries as a tree into the provided element.
 * @param {HTMLElement} targetEl - The tree container element.
 * @param {Array<{name: string, isDirectory: boolean}>} entries - Directory entries.
 * @param {string} path - The current relative path (for building child paths).
 */
export function renderTree(targetEl, entries, path = "") {
  const ul = document.createElement("ul");
  ul.className = "tree";
  for (const entry of entries) {
    ul.appendChild(createEntryEl(entry, path));
  }
  targetEl.replaceChildren(ul);
}

/**
 * Renders children into a directory's <li> element.
 * @param {HTMLElement} li - The directory <li> element.
 * @param {Array<{name: string, isDirectory: boolean}>} entries - Child entries.
 * @param {string} path - The directory's relative path.
 */
export function renderChildren(li, entries, path) {
  const ul = document.createElement("ul");
  ul.className = "tree children";
  for (const entry of entries) {
    ul.appendChild(createEntryEl(entry, path));
  }
  li.appendChild(ul);
}

/**
 * Renders the conversation into the messages container.
 * @param {HTMLElement} container - The messages container element.
 * @param {Array<{role: string, content: string, toolCalls?: Array<{name: string, args: object}>}>} messages - Messages to show.
 */
export function renderMessages(container, messages) {
  container.replaceChildren();
  if (messages.length === 0) {
    const p = document.createElement("p");
    p.className = "chat-placeholder";
    p.textContent = "Your conversation will appear here";
    container.appendChild(p);
    return;
  }
  for (const msg of messages) {
    const wrap = document.createElement("div");
    wrap.className = `chat-msg chat-msg-${msg.role}`;

    const role = document.createElement("span");
    role.className = "chat-msg-role";
    role.textContent =
      msg.role === "user"
        ? "You"
        : msg.role === "assistant"
          ? "Model"
          : "Error";

    if (msg.toolCalls?.length) {
      const badges = document.createElement("div");
      badges.className = "chat-msg-tools";
      for (const call of msg.toolCalls) {
        const badge = document.createElement("span");
        badge.className = "chat-msg-tool";
        const label = call.label ?? call.name;
        const path = call.args?.path;
        badge.title = `${call.name}(${JSON.stringify(call.args)})`;
        badge.textContent = `${call.icon ?? "🔧"} ${label}${path ? ` ${path}` : ""}`;
        badges.appendChild(badge);
      }
      wrap.append(role, badges);
    } else {
      wrap.append(role);
    }

    const content = document.createElement("div");
    content.className = "chat-msg-content";
    content.textContent = msg.content;

    wrap.append(content);
    container.appendChild(wrap);
  }
}

/**
 * Renders file content with line numbers into a <code> element.
 * @param {HTMLElement} codeEl - The <code> element to fill.
 * @param {string} text - The file's text content.
 */
export function renderLines(codeEl, text) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  codeEl.replaceChildren();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement("span");
    row.className = "line";

    const num = document.createElement("span");
    num.className = "line-num";
    num.textContent = String(i + 1);

    const code = document.createElement("span");
    code.className = "line-code";
    code.textContent = lines[i];

    row.append(num, code);
    frag.appendChild(row);
  }
  codeEl.appendChild(frag);
}

function createEntryEl(entry, path) {
  const li = document.createElement("li");
  const childPath = path ? `${path}/${entry.name}` : entry.name;

  if (entry.isDirectory) {
    li.className = "entry dir";
    li.dataset.path = childPath;

    const toggle = document.createElement("button");
    toggle.className = "toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "▸";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.name;

    li.append(toggle, label);
  } else {
    li.className = "entry file";
    li.dataset.path = childPath;

    const spacer = document.createElement("span");
    spacer.className = "toggle-spacer";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.name;

    li.append(spacer, label);
  }

  return li;
}
