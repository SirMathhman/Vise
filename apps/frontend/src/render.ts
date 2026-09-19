import { health } from "./api/client.js";
import { setupFileViewer } from "./components/fileTree.js";
import { setupLlm } from "./components/llm.js";
import { setupPanelDividers } from "./components/panels.js";

export async function render(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <main>
      <header class="masthead">
        <div class="brand">
          <h1>Vise</h1>
          <p class="tagline">File &amp; Directory Viewer</p>
        </div>
        <p id="status">Fetching backend status&hellip;</p>
      </header>
      <div class="layout">
        <section id="listing">
          <h2>Contents</h2>
          <code id="ls-path"></code>
          <ul id="ls-items" aria-label="files and directories"></ul>
        </section>
        <div
          class="panel-divider"
          id="divider-1"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the contents and viewer panels"
          tabindex="0"
        ></div>
        <section id="viewer">
          <div
            id="viewer-url-bar"
            class="viewer-url-bar"
            aria-label="open a URL as an embedded tab"
          >
            <button
              id="viewer-url-open"
              class="btn btn-ghost"
              type="button"
              title="Open a URL as an embedded tab in this panel"
            >
              Open URL
            </button>
            <input
              id="viewer-url-input"
              type="text"
              aria-label="URL to open"
              placeholder="www.example.com or https://…"
              hidden
            />
          </div>
          <h2 id="viewer-title">File contents</h2>
          <div
            id="tab-bar"
            class="tab-bar"
            aria-label="open file tabs"
          ></div>
          <div id="viewer-actions"></div>
          <pre id="viewer-body"><span class="viewer-hint">Select a file to view its contents.</span></pre>
        </section>
        <div
          class="panel-divider"
          id="divider-2"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the viewer and model panels"
          tabindex="0"
        ></div>
        <section id="llm">
          <h2>Model</h2>
          <div class="llm-controls">
            <select
              id="llm-conversation"
              aria-label="conversation"
              title="Switch conversation"
            ></select>
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
          <div class="llm-controls">
            <select id="llm-model" aria-label="model"></select>
            <select
              id="llm-profile"
              aria-label="profile"
              title="The profile this conversation runs under (system prompt, allowed tools, hooks)"
            ></select>
            <button
              id="llm-profiles-open"
              class="btn btn-ghost"
              type="button"
              title="Create, edit, or delete profiles"
            >
              Profiles
            </button>
            <button
              id="llm-skills-open"
              class="btn btn-ghost"
              type="button"
              title="Create, edit, or delete skills"
            >
              Skills
            </button>
          </div>
          <div class="llm-transcript-head">
            <p id="llm-context" class="llm-context" aria-label="context usage"></p>
            <div class="llm-follow-row"></div>
          </div>
          <div id="llm-response">
            <span class="llm-hint">Start a conversation.</span>
          </div>
          <div class="llm-composer">
            <textarea
              id="llm-prompt"
              aria-label="message"
              placeholder="Ask about the files, e.g. what's in apps/backend"
            ></textarea>
            <button id="llm-send" class="btn" type="button">Send</button>
          </div>
          <div id="llm-profiles-overlay" class="llm-profiles-overlay" hidden>
            <div
              class="llm-profiles-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Manage profiles"
            >
              <div class="llm-profiles-modal-header">
                <h3>Profiles</h3>
                <button
                  id="llm-profiles-close"
                  class="btn btn-ghost"
                  type="button"
                >
                  Close
                </button>
              </div>
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
              <p class="llm-profiles-hint">Rename the selected profile:</p>
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
              <p class="llm-profiles-hint">
                Subagents spawned under this profile may run under:
              </p>
              <div
                id="llm-profile-subagent-profiles"
                aria-label="profile allowed subagent profiles"
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
              <input
                id="llm-profile-max-tool-turns"
                class="llm-hook"
                type="number"
                aria-label="profile max tool turns"
                min="1"
                step="1"
                placeholder="Max tool turns (default 100)"
                title="The maximum number of model-call rounds (tool iterations) a single turn may run before it must produce a final answer. When the cap is hit, you are asked whether to allow more rounds. Subagents under this profile use the same number as their own cap."
              />
            </div>
          </div>
          <div id="llm-skills-overlay" class="llm-profiles-overlay" hidden>
            <div
              class="llm-profiles-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Manage skills"
            >
              <div class="llm-profiles-modal-header">
                <h3>Skills</h3>
                <button
                  id="llm-skills-close"
                  class="btn btn-ghost"
                  type="button"
                >
                  Close
                </button>
              </div>
              <div class="llm-profiles-editor-row">
                <select
                  id="llm-skill-editor"
                  aria-label="skill to edit"
                ></select>
                <button
                  id="llm-skill-new"
                  class="btn btn-ghost"
                  type="button"
                >
                  New
                </button>
                <button
                  id="llm-skill-delete"
                  class="btn btn-ghost"
                  type="button"
                >
                  Delete
                </button>
              </div>
              <p class="llm-profiles-hint">
                Name a new skill (unique, fixed after creation):
              </p>
              <input
                id="llm-skill-name"
                class="llm-hook"
                type="text"
                aria-label="new skill name"
                placeholder="skill-name"
              />
              <p class="llm-profiles-hint">
                Edit the selected skill:
              </p>
              <input
                id="llm-skill-summary"
                class="llm-hook"
                type="text"
                aria-label="skill summary"
                placeholder="One-line summary shown to the model (why to use this skill)"
              />
              <textarea
                id="llm-skill-content"
                aria-label="skill content"
                placeholder="Full instructions loaded into context when the model calls use_skill with this skill's name"
              ></textarea>
            </div>
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

  const fileViewer = await setupFileViewer(root);
  setupLlm(root, fileViewer);
  setupPanelDividers(root);
}
