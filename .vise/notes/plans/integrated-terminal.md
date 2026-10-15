## Plan: Integrated Terminal Panel

A live, interactive **powershell.exe** terminal embedded in Vise's web UI — the user types into it directly (real echo, line editing, arrow-key history, ANSI colors), rendered with **xterm.js**. Per-connection (each tab gets its own shell), like every other panel. Backend is a real pseudo-console via **ConPTY over `bun:ffi` on `kernel32.dll`** — no new native binary, reusing the `dlopen` pattern already in the desktop worker.

**TL;DR / approach:**

- This is a _new surface_, not a refactor of the `run_powershell` tool. The existing tool path (`src/tools/shell.ts`, the chat-transcript tool result) is untouched. The interactive panel is a separate per-connection shell with its own spawn, its own stdout pipe, and its own WebSocket message types.
- Windows has no native PTY. ConPTY (`CreatePseudoConsole` + `CreateProcessW`, both in `kernel32.dll`) is the only way to get a genuine interactive console (prompt, readline, colors). `kernel32.dll` is already `dlopen`'d on the main thread in `src/web/desktop/desktop.ts` (for `hideOwnConsole`), so we reuse that exact `bun:ffi`/`dlopen` + wide-string helper pattern — zero new native binaries to ship.
- Frontend adds **xterm.js** as a runtime dep bundled into the web UI, the same way `marked`/`dompurify` are bundled in `web/src/markdown.ts`.

---

### Phase 1 — ConPTY backend (`src/web/terminal/`)

**1a. `src/web/terminal/conpty.ts` — native bindings (the meat).**

- `dlopen("kernel32.dll")` via `bun:ffi`, following `src/web/desktop/desktop.ts` (main-thread `dlopen`; `src/web/desktop/window-worker.ts` line ~16 has the `cString`/wide-string helpers — wide strings are `Buffer.from(s + "\0", "utf16le")`).
- Bind: `CreatePseudoConsole`, `CreateProcessW` (or `CreateProcess` with `EXTENDED_STARTUPINFO` + `CONSOLE pseudoc*`), `ResizePseudoConsole`, `ReadFile`, `WriteFile`, `CloseHandle`, `TerminateProcess`/`WaitForSingleObject` (for exit detection), `SetConsoleCtrlEvent` (for Ctrl+C → the process).
- `spawnPty(opts: { cwd, cols, rows, env? }): PtyHandle` — creates the ConPTY, spawns `powershell.exe` as its child, returns `{ inHandle, outHandle }` + the child PID. Initial size from `cols`/`rows`.
- A **read loop** over the output handle: `ReadFile` into a buffer in chunks, emit UTF-8 chunks to a callback. Handle partial reads (ConPTY frequently returns < requested bytes); keep the loop running until the process exits.
- `writeInput(handle, utf8: string)` — convert UTF-8 → UTF-16 and `WriteFile` to the input handle (xterm sends UTF-8 keystrokes; ConPTY input is UTF-16).
- `resize(handle, cols, rows)` → `ResizePseudoConsole`.
- `close(handle)` — terminate the child and close handles; guard against double-close.
- Keep it Windows-only and isolated: a top-level `if (process.platform !== "win32")` guard that throws a clear "interactive terminal is Windows-only" `ViseError` otherwise, so the rest of the code never touches the FFI on other platforms. (The shell tool itself is already Windows-only per AGENTS.md.)
- Watch the hard rules: files < 500 lines, functions < 100 lines — if the FFI block list + read loop push past that, split `conpty-ffi.ts` (raw bindings) from `conpty.ts` (the session loop).

**1b. `src/web/terminal/terminal.ts` — per-connection `TerminalSession`.**

- `class TerminalSession` owning one `PtyHandle` for the connection. API: `open(cwd, cols, rows, onData, onExit)`, `write(utf8)`, `resize(cols, rows)`, `close()`. `onData(bytes: Uint8Array)` fires per read-loop chunk; `onExit(code)` fires once.
- `cwd` = the connection's root (`ws.data.root`), so the shell opens in the same folder as the session — same threading as `run_powershell` receives its `cwd` (`src/tools.ts:144`).
- Lazily created: not spawned until the page first opens the panel.

**1c. Wire into `ConnectionState` (`src/web/server.ts`).**

- In `makeConnectionState` (`server.ts:412`), create the connection's `TerminalSession` (do not open it yet).
- Wire its callbacks to the per-connection `send` closure: `onData` → `send({ type: "term_data", data: base64(bytes) })`; `onExit` → `send({ type: "term_exit", code })`. Use **base64** for the chunk payload (binary-safe; raw UTF-8 strings would need escaping in JSON).
- On connection close (`server.ts:363`), call `terminal.close()` — this is the per-connection teardown next to the existing `unwatch`/`lease` cleanup, guaranteeing no orphaned shells (matches the "every tab is an independent `ConnectionState`" invariant).

**1d. Page→server messages (`WireMessage`, `server.ts:510`).** Add handlers for:

- `term_open { cols, rows }` → `terminal.open(ws.data.root, cols, rows, …)` (idempotent if already open — a reload of an open panel must not double-spawn).
- `term_input { data: base64 }` → `terminal.write(utf8FromBase64(data))`.
- `term_resize { cols, rows }` → `terminal.resize(cols, rows)`.
- `term_close {}` → `terminal.close()`.
  Dispatch these in the connection `message` handler next to the existing line/command dispatch (`server.ts` message handler, ~line 346).

---

### Phase 2 — Frontend (`web/`)

**2a. Add xterm.js.**

- `xterm` (+ `xterm-addon-fit`) to `package.json` runtime deps, and import it in the web bundle the way `web/src/markdown.ts` imports `marked`/`dompurify` (bundled into the web UI). If the build needs the DOM types, add `xterm` to the web tsconfig like the DOM lib already is.

**2b. `web/src/terminal/terminal.ts` — `createTerminal()` panel.**

- Follow the **`files` workspace side-view pattern** (not the dropdown group): own DOM, a `toggle()`, and a `handle(message)` returning a bool — added to `serverPanels[]` in `web/src/app.ts:106` so it short-circuits the `switch` for its own message types. Reference: `web/src/workspace/workspace.ts` `createWorkspace()`.
- Owns an `xterm.Terminal` instance; renders into an `<div class="terminal-body">` (xterm manages its own scrollback; we do NOT reuse the `#log` transcript or `appendToolResult`, which are `textContent` and would mangle ANSI).
- Wire: `term.onData(data)` → post `{ type:"term_input", data: btoa(data) }`; `term.onResize({cols,rows})` → post `term_resize`; the panel's open → post `term_open {cols,rows}`; close → post `term_close`.
- `handle(message)`: `term_data` → decode base64 → `term.write(decoded)`; `term_exit` → show a `process exited (code)` line in the panel and mark it dead (further `term_input` is a no-op or auto-opens a fresh shell on next keystroke — decide in impl, default: show exit and require reopen). Returns `true` for these types, `false` otherwise.

**2c. HTML + top bar (`web/index.html`, `web/src/app.ts`).**

- Add `<button id="terminal-btn" class="topbar-item" title="Toggle terminal">terminal</button>` in `<nav id="topbar">` (index.html:11–31), next to `files`.
- Add `<aside id="terminal" class="terminal hidden">…</aside>` as a sibling of `<aside id="workspace">` inside `<div id="shell">` (index.html:154–207 region).
- In `app.ts` (~line 487, next to the `files-btn` listener): `terminalBtn.addEventListener("click", () => terminal.toggle())`.

**2d. CSS (`web/styles.css`).**

- `.terminal { flex: 1 1 0; min-width:0; display:flex; flex-direction:column; border-right:1px solid var(--border); background: var(--panel); }` mirroring `.workspace` (styles.css:862–944); `.terminal.hidden` hides it; an active-state rule `body:has(#terminal:not(.hidden)) #terminal-btn { border-bottom-color: var(--accent); }` (mirror the `files-btn` rule).
- Add to the narrow-screen `@media (max-width: 800px)` block so it stacks like `workspace` does. Decide whether both `workspace` and `terminal` can be open at once (they're independent siblings; default yes, each toggles itself).

---

### Relevant files

- `src/web/desktop/desktop.ts` — **reference only**: the `dlopen("kernel32.dll"`/`user32.dll`) `bun:ffi` pattern + wide-string helpers to copy into `conpty.ts`. Proves main-thread `dlopen` is fine.
- `src/web/desktop/window-worker.ts` (~line 16) — `cString` / wide-string helper pattern.
- `src/tools/shell.ts` — **do not modify**, but it's the model for `ProcessRecord`, per-chunk `data` handlers, and `cwd` threading. The interactive panel is a _separate_ surface from this tool.
- `src/web/server.ts` — `ConnectionState` (`:393`), `makeConnectionState` (`:412`), `WireMessage` (`:510`), the `send` closure (`:421`), the `state` map + per-conn root (`:280`, `:216`). Add `TerminalSession` + the four `term_*` dispatch handlers here.
- `web/src/app.ts` — `serverPanels[]` (`:106`), the `files-btn` toggle (`:487`), the page-side `send`/`post` closure used to send `ask_answer`.
- `web/index.html` — top bar (`:11–31`), the `<aside>` sibling region (`:154–207`).
- `web/styles.css` — `.workspace` block (`:862–944`) and top bar (`.topbar`, `:1144–1168`) to mirror.
- `web/src/markdown.ts` — the pattern for bundling a runtime dep (`marked`/`dompurify`) into the web UI; xterm.js follows it.
- `web/src/workspace/workspace.ts` — the `createWorkspace()` side-view pattern to mirror for `createTerminal()`.

**New files:** `src/web/terminal/conpty.ts` (+ maybe `conpty-ffi.ts`), `src/web/terminal/terminal.ts`, `web/src/terminal/terminal.ts`.

---

### Verification

**Automated** (`bun test` in `test/`):

1. `bunx tsc --noEmit` (server/core) passes with the new `src/web/terminal/` modules; `bun run typecheck:web` passes for `web/src/terminal/`.
2. `bun run lint` clean on new files.
3. A ConPTY unit test (Windows-only, skipped otherwise): spawn a pty running `powershell.exe`, write `"echo hello"\r`, read back until it contains `hello`, then `close()`; assert the process exits and no handle leak (registry empty / no dangling `ChildProcess`). Mirror how `test/` skips platform-specific suites.
4. A page-message contract test if one exists for `WireMessage`/`ServerMessage` — assert `term_data`/`term_exit`/`term_open`/`term_input`/`term_resize`/`term_close` round-trip the discriminated union without type errors.

**Manual:** 5. `bun run dev:web`, open the page with a root, click **terminal**: a powershell prompt appears. Type `dir`, `git status`, run a loop that prints progress — confirm live streaming (output appears mid-run, not only at the end), ANSI colors render, and Ctrl+C interrupts a long-running command. 6. Resize the panel → `cols`/`rows` propagate (a `dir` column-width reflow, `resize` from the shell works). 7. Open two tabs on the same folder → each runs an independent shell; closing one tab kills only its shell (no orphan powershell; check `tasklist`). 8. No-folder session: the panel opens with cwd at `~/.vise/no-folder` (or the chosen no-folder root) and works. 9. `bun run build:exe` → the terminal works from the compiled `vise.exe` (ConPTY via `kernel32.dll`, which is a system DLL so no embed needed — but confirm the ffi `dlopen` path resolves in the compiled build, since the webview DLL ships by an explicit `type:"file"` import and kernel32 does not).

---

### Decisions

- **Backend: ConPTY via `bun:ffi` on `kernel32.dll`** (not `node-pty`, not pure stdio). Reuses the system DLL already `dlopen`'d in `desktop.ts`; zero new native binaries to ship; the only approach that gives real echo + line editing + ANSI. Pure-stdio is rejected (no real console ⇒ no readline/history/prompt over a pipe). `node-pty` is rejected as first choice because it adds a `.node` binary with no existing embed mechanism in `build-exe.ts`; it remains a fallback if hand-written ConPTY proves too fragile.
- **Per-connection** shell (user choice): one `TerminalSession` per `ConnectionState`, created lazily on first panel open, closed on connection close. Tabs do not share a shell.
- **powershell.exe only** (user choice): matches the existing `run_powershell` backend; no shell dropdown in v1.
- **base64** for stdout chunk + stdin payloads over the WebSocket (binary-safe; avoids JSON-escaping raw control bytes).
- **Separate surface**: the `run_powershell` tool and chat-transcript tool output are untouched; xterm.js is a new rendering path (the transcript's `textContent` display would mangle ANSI).
- **Scope excluded (v1):** the `vise-cli.exe` terminal getting this panel; git-bash/wsl shell selection; cross-tab shared shell; scrollback persistence across reload; running the panel on non-Windows platforms (clear error instead). Each is a natural later extension.

---

### Further Considerations

1. **ConPTY output encoding** — ConPTY pipes are generally UTF-8 (this is how `node-pty` reads them), but the prompt/ANSI path through PowerShell can be code-page sensitive. If the first read back is garbled, the fix is to set the child's console to UTF-8 (`chcp 65001`) or convert UTF-16 → UTF-8 in the read loop. Flag this as the #1 thing to watch in manual verification; keep the chunk contract base64 either way so the wire format doesn't change.
2. **Ctrl+C semantics** — ConPTY needs `SetConsoleCtrlEvent` (or the child handles the console event) for Ctrl+C to reach PowerShell rather than just being a byte. Verify interrupt works in manual step 5; if it doesn't, the fallback is to synthesize it on the server from a key-combination in `term_input`.
3. **Open vs reopen after exit** — default: on `term_exit`, show `process exited (code)` and require the user to reopen (or press a key) to start a fresh shell. Confirm this matches expectation; alternative is auto-respawn on next keystroke, which is nicer but adds a state flag to `TerminalSession`.
