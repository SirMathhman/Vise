## Plan: Integrated Terminal Panel

Add a collapsible bottom terminal panel to the web UI. The user opens it to get a full interactive shell (spawned per connection, tied to the session root). Raw bytes are piped between the shell process and a browser-side terminal emulator (xterm.js). Only available when a file system exists (a session root is set).

**Why**: The agent's `run_powershell` is one-shot and invisible — the user has no way to run interactive commands (edit a file with `vim`, `cd` around, inspect state) without leaving the web UI. A persistent interactive terminal in the page closes that gap. It follows the exact same bidirectional-streaming pattern as the browser view (server→page output chunks, page→server input bytes over the same WebSocket).

**How**: Spawn the user's shell with piped stdio per connection. The browser renders it with xterm.js. The shell lives for the life of the WebSocket connection; toggling the panel only shows/hides the DOM. Each connection is independent.

---

**Steps**

### Phase 1 — Server: process + WS plumbing

1. **`src/web/term-process.ts`** — new module, the server-side shell manager. One class or function set, no module-level state (same pattern as `browser-bridge.ts`): a `TermProcess` created per connection, owns one child process.
   - `open()`: spawn the shell. On Windows, spawn `cmd.exe` with args `/K` and `stdio: ["pipe", "pipe", "pipe"]`, `cwd` set to the session root. On POSIX, spawn the user's `$SHELL` (read from `process.env` or default `/bin/bash`) with `stdio: ["pipe", "pipe", "pipe"]` and `shell: false`. Store the process in a local variable; register a close/exit handler.
   - Attach `data` listeners to stdout and stderr; on each `data` event, call a callback with the raw bytes (the connection's `send` function, wrapped as a `{ type: "term_output", data: base64 }` message). No accumulation — one WS message per chunk, lowest latency.
   - `write(bytes: Uint8Array)`: write to stdin. If stdin is already closed (process exiting), swallow silently.
   - `close()`: kill the process (SIGTERM), wait briefly for exit, resolve. Called on connection close and on `term_close` messages.
   - On process exit (normal or signal), emit a `{ type: "term_exit", code: number | null }` message once. Do not re-spawn.
   - The module is pure plumbing: no `node:` imports beyond `child_process` (this is edge code, like `src/tools/shell.ts`).

2. **`src/web/server.ts` — add `term_open`, `term_input`, `term_close` to the non-queued routing** in `handleMessage()`, alongside the existing `browser_*` / `env_get` / `note*` branch. On `term_open`, create the `TermProcess` if not yet created for this connection and store it on the connection state object. On `term_input`, write the `data` field (base64-decoded) to the process stdin. On `term_close`, call `close()` on the process.
   - In `makeConnectionState` (or the connection cleanup that runs on WebSocket close), add: if a `TermProcess` exists for this connection, call its `close()`. Follow the same pattern as how `browser_*` state is cleaned up per-connection.
   - The `TermProcess` must be constructed with the session root's absolute path (available from the connection's session state) so `cwd` is correct. For no-folder sessions, do not create a `TermProcess` — the messages are ignored (the page will not send them since the button is hidden).

3. **`src/web/server.ts` — send `term_available: true` on connect** as part of the initial handshake or in the `root` message. The page uses this to show/hide the terminal button. Alternatively: the page can infer it from the `root` message it already receives (if `root` is a valid directory path, not `none` or absent, the terminal is available). **Decision**: infer client-side from the `root` message — no new server message needed. Simpler, and the page already knows the root.

### Phase 2 — Browser: xterm.js dependency + terminal pane DOM

4. **Add xterm.js as a runtime dependency** to the web bundle. In `web/src/` (or wherever the web bundle's dependency manifest lives — `package.json` at the project root, since `web/` is part of the same package), add `@xterm/xterm` (the modern package name; `xterm` was renamed to `@xterm/xterm`). It will be imported from a new `web/src/terminal.ts` module and bundled by Bun.
   - The existing runtime deps (`marked`, `dompurify`) are in the root `package.json` and imported directly in `web/src/` modules — `@xterm/xterm` follows the same pattern.

5. **`web/index.html`** — add the terminal DOM structure inside `#app`, between `<section id="log">` and `<footer class="context-bar">`:
   - A `<section id="terminal" class="terminal hidden">` containing an empty `<div id="term-host" class="term-host"></div>` (xterm.js mounts into `#term-host`).
   - A thin `<button id="term-toggle" class="term-toggle">terminal</button>` in the `<header class="bar">` alongside the existing tools/burst/goal buttons (it toggles the panel's `hidden` class, same as how `files` toggles the workspace — a simple class toggle, not part of the `panel-switch.ts` dropdown group, because it is a persistent split, not a dropdown).
   - When the terminal is hidden, `#terminal` has `display: none`. When shown, it has a fixed height (initially 180px, resizable by a drag handle — see step 6).

6. **`web/styles.css`** — add styles:
   - `.terminal.hidden { display: none; }`
   - `.terminal { height: 180px; overflow: hidden; border-top: 1px solid var(--border); flex-shrink: 0; }` (height is set by JS when resized; the CSS default is the initial value)
   - `.term-host { width: 100%; height: 100%; }` — xterm.js sets its own inner dimensions; the host div must be full size.
   - `.term-toggle` — styled to match the existing header bar buttons (small text button, dim until hovered).
   - A resize handle: a `<div class="term-resize" style="cursor: ns-resize; height: 4px; position: absolute; top: 0; left: 0; right: 0; z-index: 10;">` inside `#terminal`, with a `mousedown` handler that adjusts the terminal section's height and updates xterm.js's dimensions.

7. **`web/src/terminal.ts`** — new module, the browser-side terminal pane controller. Follows the `createBrowserView` pattern (owns a DOM slice, exposes a small API, consumes a subset of server messages):
   - `createTerminalPane(host: HTMLElement, send: (msg: object) => void): { open(): void; close(): void; handle(msg: object): boolean; destroy(): void }`
   - `open()`: if xterm.js is not yet initialised, create a new `Terminal` instance with sensible options (theme matching the page's dark/light theme, `cursorBlink: true`, `scrollback: 5000`, `fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"`, `fontSize: 13`, `convertEol: true`). Mount it into `host`. Add a `data` listener that sends `{ type: "term_input", data: base64(bytes) }` to the server. Add a `term_open` send (the first `open()` call sends it; subsequent calls after `close()` just re-show the existing pane — the process is still alive).
   - `close()`: hide the pane (`host.parentElement.classList.add("hidden")`). Do NOT send `term_close` — the shell keeps running while the page is open. Send `term_close` only from `destroy()`.
   - `handle(msg)`: if `msg.type === "term_output"`, append the decoded bytes to the xterm write queue (xterm.js has `term.write(data)` which handles backpressure internally). If `msg.type === "term_exit"`, append a line like `\n[process exited with code N]` to the terminal and disable the input. Return `true` if the message was consumed.
   - `destroy()`: send `term_close`, dispose the xterm.js instance, remove event listeners. Called on page unload or connection close.
   - **Resize**: listen for `resize` on the terminal host element (or use `ResizeObserver`) and call `term.fit()` (requires the `@xterm/xterm-fit` addon, also added as a dependency). On manual resize (drag handle), update the element height and call `term.fit()`.

8. **`web/src/app.ts`** — wire the terminal pane into the existing message dispatch and lifecycle:
   - In the main message handler (where `workspace.handle(msg)` and `browserView.handle(msg)` are called), add `if (terminal.handle(msg)) return;` for the terminal's message subset.
   - On the `term-toggle` button click: toggle the `hidden` class on `#terminal`; on first show, call `terminal.open()`; on hide, call `terminal.close()`.
   - On page unload / `beforeunload` / connection close: call `terminal.destroy()`.
   - Hide the `term-toggle` button when there is no file system: check the same condition the page already uses to hide the file tree (the `root` value from the server). If root is `none` or absent, add `hidden` to the button and do not create the terminal pane.

### Phase 3 — Edge cases and polish

9. **Scrollback and performance**: xterm.js's default `scrollback: 1000` is fine for a chat-adjacent panel. Set `scrollback: 5000` to give the user reasonable history. The pane's height is capped (it is a split, not the full viewport), so the DOM size is bounded. No special optimization needed for v1.

10. **No-folder sessions**: The `term-toggle` button is hidden (step 8). If the server somehow receives `term_open` on a no-folder connection, it creates the process with `cwd = process.cwd()` (the server's start directory) as a fallback — same behavior as `run_powershell` with no cwd.

11. **Connection close / reload**: When the WebSocket closes, the server's per-connection cleanup kills the shell (step 2). On reload, a fresh `term_open` spawns a new shell. The user loses shell state on reload — this is expected and consistent with the browser tab's state.

12. **Theme**: xterm.js supports theme objects. Read the current theme (`document.documentElement.dataset.theme`) and apply the matching xterm theme (dark: dark background, light: light background with dark text). On theme change, call `term.options.theme = newTheme`.

### Phase 4 — Verification

1. **Open the terminal**: load the page with a folder root → `term-toggle` button is visible → click it → panel appears, shell prompt is shown, typing appears and is echoed.
2. **Run a command**: type `dir` (Windows) or `ls` (POSIX) + Enter → output appears in the panel.
3. **Interactive**: start a command that reads stdin (e.g., `cat` or `python -i`) → type input → it is read back.
4. **Ctrl+C**: start a long-running command (e.g., `sleep 100`) → send Ctrl+C → the process is interrupted and a new prompt appears.
5. **Toggle hide/show**: hide the panel → the shell is still running (run `pwd`, hide, show, run `pwd` again — same cwd, no respawn). Show → output is continuous (nothing lost while hidden).
6. **Exit**: type `exit` (or `Ctrl+D` on bash) → `[process exited with code 0]` appears, input is disabled.
7. **Reload**: reload the page → a fresh shell starts (new prompt, no prior state).
8. **No folder**: open the page without a folder (or with `?root=none`) → `term-toggle` button is absent.
9. **Multiple connections**: open two browser tabs on the same folder → each has its own independent shell; killing one does not affect the other.
10. **Type-check**: `bun run typecheck:web` passes. **Lint**: `bun run lint` passes. **Build**: `bun run build:exe` succeeds (xterm.js is bundled).

---

**Relevant files**

- `src/web/term-process.ts` — **new**. Server-side shell process manager (spawn, pipe bytes, kill). Edge module, like `src/tools/shell.ts`.
- `src/web/server.ts` — add `term_open` / `term_input` / `term_close` to the non-queued routing in `handleMessage()`; add `TermProcess` creation to per-connection state; add cleanup on connection close.
- `web/index.html` — add `<section id="terminal">` inside `#app` between `#log` and `.context-bar`; add `<button id="term-toggle">` to `<header class="bar">`.
- `web/styles.css` — add `.terminal`, `.term-host`, `.term-toggle`, `.term-resize` styles.
- `web/src/terminal.ts` — **new**. Browser-side xterm.js pane controller (`createTerminalPane`). Follows `web/src/browser-view.ts` pattern.
- `web/src/app.ts` — wire `terminal.handle(msg)` into the message dispatch; toggle button handler; lifecycle (destroy on unload); hide button for no-folder.
- `package.json` (root) — add `@xterm/xterm` and `@xterm/xterm-fit` to dependencies.
- `src/tools/shell.ts` — **reference only** (shows the `spawnPowerShell` pattern, `ProcessRecord` type, and how `cwd` is passed).
- `src/web/browser-bridge.ts` — **reference only** (the `browser_frame` / `browser_input` message shapes to mirror for `term_output` / `term_input`).
- `web/src/browser-view.ts` — **reference only** (the `createBrowserView` API shape: `show` / `hide` / `handle` / input forwarding).
- `web/src/panel-switch.ts` — **not used** (the terminal is a persistent split, not a dropdown; it uses a simple class toggle, not `createPanelGroup`).

**Decisions**

- **Piped stdio, not a PTY**: Bun does not expose ConPTY or a PTY device. Spawning with `stdio: ["pipe","pipe","pipe"]` gives a fully interactive shell on Windows (`cmd.exe /K` with pipes works for prompt, echo, tab-completion, background jobs). The limitation: terminal resize does not send SIGWINCH, so programs that query terminal dimensions report the default (80x25). Acceptable for v1. A PTY bridge is a follow-up.
- **Process lifetime = connection lifetime**: the shell is killed when the WebSocket closes. Hiding the panel does not kill the shell. Reload = new shell. No persistence.
- **One shell per connection**: independent per tab, like the browser backend. No shared shell state across tabs.
- **Bottom split, not a dropdown**: a full interactive terminal needs to be visible alongside the chat. A dropdown would hide the conversation. A collapsible bottom section (180px initial, drag-to-resize) keeps both visible.
- **xterm.js**: the standard browser terminal emulator. It handles ANSI, cursor positioning, colors, hyperlinks, and has built-in backpressure. MIT license, small (~200 KB). Bundled with Bun like `marked` and `dompurify`.
- **Gating**: client-side, inferred from the `root` message the page already receives. No new server message. No-folder sessions hide the button; the server ignores `term_*` messages on no-folder connections.
- **Excluded (v1)**: terminal resize SIGWINCH (needs a PTY bridge), multiple concurrent shells per connection, shell state persistence across reloads, agent-driven terminal (the agent already has `run_powershell`), terminal themes beyond dark/light, tab-completion of the panel with multiple terminal instances.

**Further considerations**

1. **PTY for resize**: if SIGWINCH matters (running `htop`, `vim`, `tmux`), the next step is a ConPTY bridge on Windows (spawn `conhost.exe` with a pseudoconsole handle and pipe through it) and `openpty(3)` on POSIX. This would replace the plain `stdio: "pipe"` spawn in `term-process.ts` with a PTY-backed spawn and add a `term_resize(cols, rows)` message. Recommend deferring until there is a concrete user need.
2. **Agent visibility**: if the agent should be able to see the user's terminal output (e.g., "what's in my terminal right now?"), the `TermProcess` could expose a `snapshot()` method returning the last N bytes of output, and a `terminal_snapshot` tool could be added to `src/tools.ts`. This is a clean follow-up that reuses the existing process plumbing.
3. **Shell choice**: for v1, hardcode `cmd.exe /K` on Windows and `$SHELL` on POSIX. A settings option ("terminal shell") can be added later via the existing `env_get`/`env_set` mechanism if users want to override.
