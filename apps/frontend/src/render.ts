import { health } from "./api/client.js";
import { setupFileViewer } from "./components/fileTree.js";
import { setupLlm } from "./components/llm.js";

export async function render(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <main>
      <h1>Vise</h1>
      <p class="tagline">File &amp; Directory Viewer</p>
      <div class="status-row">
        <p id="status">Fetching backend status&hellip;</p>
      </div>
      <div class="layout">
        <section id="listing">
          <h2>Contents of <code id="ls-path"></code></h2>
          <ul id="ls-items" aria-label="files and directories"></ul>
        </section>
        <section id="viewer">
          <h2 id="viewer-title">File contents</h2>
          <div id="viewer-actions"></div>
          <pre id="viewer-body"><span class="viewer-hint">Select a file to view its contents.</span></pre>
        </section>
        <section id="llm">
          <h2>Model</h2>
          <div class="llm-controls">
            <select
              id="llm-conversation"
              aria-label="conversation"
              title="Switch conversation"
            ></select>
            <select id="llm-model" aria-label="model"></select>
            <button id="llm-send" class="btn" type="button">Send</button>
            <button
              id="llm-new"
              class="btn btn-ghost"
              type="button"
              title="Start a new conversation"
            >
              New
            </button>
            <button
              id="llm-delete"
              class="btn btn-ghost"
              type="button"
              title="Delete the selected conversation"
            >
              Delete
            </button>
          </div>
          <p id="llm-context" class="llm-context" aria-label="context usage"></p>
          <div id="llm-tools" aria-label="available tools"></div>
          <textarea
            id="llm-prompt"
            aria-label="message"
            placeholder="Ask about the files, e.g. what's in apps/backend"
          ></textarea>
          <div id="llm-response">
            <span class="llm-hint">Start a conversation.</span>
          </div>
        </section>
      </div>
    </main>
  `;
  const status = root.querySelector<HTMLParagraphElement>("#status");
  if (!status) return;

  try {
    const st = await health();
    status.textContent = `Backend: ${st}`;
    status.classList.add("ok");
  } catch (err) {
    status.textContent = `Backend: unreachable (${(err as Error).message})`;
    status.classList.add("err");
  }

  await setupFileViewer(root);
  setupLlm(root);
}
