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
            <select
              id="llm-profile"
              aria-label="profile"
              title="The profile this conversation runs under (system prompt, allowed tools, hooks)"
            ></select>
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
          <details id="llm-profiles" class="llm-profiles">
            <summary class="llm-profiles-title">Profiles</summary>
            <div class="llm-profiles-editor-row">
              <select id="llm-profile-editor" aria-label="profile to edit"></select>
              <button id="llm-profile-new" class="btn btn-ghost" type="button">
                New
              </button>
              <button
                id="llm-profile-delete"
                class="btn btn-ghost"
                type="button"
              >
                Delete
              </button>
            </div>
            <input
              id="llm-profile-name"
              class="llm-hook"
              type="text"
              aria-label="profile name"
              placeholder="Profile name"
            />
            <textarea
              id="llm-profile-prompt"
              aria-label="profile system prompt"
              placeholder="System prompt"
            ></textarea>
            <div
              id="llm-profile-tools"
              aria-label="profile allowed tools"
            ></div>
            <input
              id="llm-profile-hook"
              class="llm-hook"
              type="text"
              aria-label="profile startup command"
              placeholder="Startup command (optional, PowerShell — runs once before the first message/task)"
              title="Runs once, before the first message/task under this profile, via the same run_command tool the model uses. Its output is added to the model's context but never shown in the transcript."
            />
            <input
              id="llm-profile-turn-hook"
              class="llm-hook"
              type="text"
              aria-label="profile turn command"
              placeholder="Turn command (optional, PowerShell — runs fresh before every turn)"
              title="Runs fresh before every turn (not just the first), via the same run_command tool the model uses. Its output is added to that turn's context but never shown in the transcript, and is never cached between turns."
            />
            <input
              id="llm-profile-end-hook"
              class="llm-hook"
              type="text"
              aria-label="profile end-of-turn check command"
              placeholder="End command (optional, PowerShell — runs after every reply; blocks on stderr)"
              title="Runs after every reply. Its stdout/stderr are shown in the transcript (truncated). If it writes to stderr, the reply is not accepted: the model sees the output and must try again."
            />
          </details>
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
