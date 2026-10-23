# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Rust crate `vise` (edition 2024) plus a TypeScript web page. Windows is the primary dev platform.

- Terminal REPL: `cargo run` (needs Strata at `http://127.0.0.1:8080`)
- Web UI: `cargo run -- web`, served at `http://127.0.0.1:3000`
- Tests: `cargo test`. One test or module: `cargo test <name-substring>`, e.g. `cargo test notes::`
- No lint or format script exists, and there is no clippy or rustfmt config in the repo.
- One-time setup: `npm install`, and `cargo install cargo-watch` for the watch loop.
- Rebuild the web page after editing `web/src/**/*.ts`: `npm run build`. This runs `tsc -p web` and then `scripts/bundle-web.mjs`.
- Watch both TypeScript and Rust: `npm run dev`.

## Things that bite

- `web/app.js` is generated, but it is committed, and the server serves that file as-is. Any TypeScript change must be rebuilt, and the new `app.js` committed with it. `cargo run -- web` does not rebuild it.
- `scripts/bundle-web.mjs` has an explicit `order` list. A compiled `.js` file missing from that list fails the bundle with an error. Add a new panel there, and keep each file after the files it uses.
- `.vise/` holds runtime state: sessions, notes, and workflows. It is not in `.gitignore`, and it is currently untracked.

## Architecture

The design is documented in depth in `ARCHITECTURE.md`, which includes known problems and planned work. Read the relevant section before changing the turn loop, tools, grammar, compaction, or the web routes. `README.md` covers the user-facing commands.

The big picture:

- **Two front ends, one turn loop.** `src/main.rs` runs the REPL and `src/web/mod.rs` runs the HTTP server. Both call `agent::run_turn`, which streams a reply, runs any tool calls, and repeats for at most 8 rounds.
- **Strata is an external server.** `src/strata.rs` is the only code that talks to it. Strata sends no CORS headers, so the browser calls the Rust `/api/chat` route, which proxies to Strata and relays the events back as server-sent events.
- **Conversation state lives in two places.** In the REPL it is `Session` in memory. In the web UI it is a copy in the page, which is lost on reload. Only the user message and the final answer are kept. Tool results are dropped from history, so later turns do not see them.
- **Tool switches are per session.** Each REPL process and each web tab (identified by a `sessionStorage` id) has its own on/off set. A switch never edits the prompt, because tool definitions sit at the front and changing them would invalidate the prompt cache. Instead, `grammar.rs` builds a GBNF grammar that stops the model from generating calls to disabled tools. A call-time refusal backs it up. `tools::note_changes` tells the model about switch changes in the next user message.
- **File and note access is confined.** `tools::resolve` only accepts relative paths that stay inside the working directory after canonicalization. Local notes live in `.vise/notes`, and global notes live in `~/.vise/notes`, which the file tools cannot reach. The write tools run with no confirmation.
- **Profiles and workflows reuse notes and tools.** A profile is a note with `profile: true`. A workflow is `.vise/workflows/<name>.json`, run as `/<name> <arg>`, and `workflow_runner.rs` runs its steps within one reply.
- **Long conversations are summarized.** `compaction.rs` appends a summary to an append-only log once the estimated size (bytes divided by 3) reaches about 75% of 131072 tokens. It also summarizes within a turn. Requests still carry the full history, which ARCHITECTURE.md calls out as a known issue.
- **The web UI follows two rules.** Avoid nested scrollbars: only one region per pane scrolls. Shared CSS layout applies to classes, never bare element types.
