/**
 * Renders the page shell (heading + tree + file viewer) into the app element.
 */
export function renderApp(appEl) {
  appEl.innerHTML = `
  <main class="page">
    <h1>Files &amp; directories</h1>
    <div class="layout">
      <div id="tree" class="tree-container"></div>
      <div id="file-viewer" class="file-viewer">
        <div class="file-viewer-header"></div>
        <pre class="file-viewer-content"><code class="placeholder">Select a file to view</code></pre>
      </div>
    </div>
    <section class="chat">
      <h2>Ask the model</h2>
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
      <div id="chat-response" class="chat-response">
        <pre class="chat-response-content"><code class="placeholder">Your reply will appear here</code></pre>
      </div>
    </section>
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
