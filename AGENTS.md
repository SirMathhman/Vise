# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Build: `cargo build`
- Run: `cargo run` (reads commands from stdin, so `printf '...' | cargo run` works for scripted checks)
- Test all: `cargo test` (47 tests, no server needed)
- Test one: `cargo test <module path or substring>`, e.g. `cargo test grammar` or `cargo test profile::tests::load_rejects_names_that_leave_the_folder`
- Lint: `cargo clippy --all-targets`. One warning is known (`ok().expect()` in test code in `src/session.rs`).

Running needs `LLAMA_API_KEY` in `.env` in the working directory (loaded by dotenvy) and a llama.cpp server at `http://127.0.0.1:9931`. The model name and URL are constants in `src/provider/llama_cpp.rs`. Tests never contact the server, so live checks are manual.

Live checks run the binary from a scratch directory with `profiles/` in it, because profiles are read from the working directory. Pass the key with `LLAMA_API_KEY=...` in the environment when there is no `.env` there.

## Architecture

`ARCHITECTURE.md` is the canonical design document. It holds the invariants, the structure, and the Open Problems. Keep it current when behaviour changes. It is partly aspirational: check the Structure section against the files before relying on it, because it names a `tools/process/` module that does not exist yet.

Layers, from the input side:

- `repl.rs` runs the loop over any `BufRead`/`Write`. It handles slash commands (never sent to the model), the approval prompt (`y`/`yes` read from the same stdin), `/compact`, and the retry after a full context. Unknown slash commands go to the model.
- `session.rs` holds the history: `Message` (System, User, Assistant with tool calls, Tool), `Turn` (checked by `Turn::new`), and `Conversation` (commit, compact, drop oldest turn). The first message is the system context with the working directory.
- `provider/` sends history to llama.cpp. `Provider` is the trait; `llama_cpp.rs` is the only implementation. It runs the tool loop, parses replies, and maps the 400 overflow error to `ContextFull`.
- `tools/` is the registry (`mod.rs`: `SPECS`, `call`), typed invocations (`types.rs`), and `WorkspaceTools` (`runner.rs`), which refuses disabled tools, asks approval for writes, and owns background PowerShell tasks. Tools that write report it through `Invocation::writes`, an exhaustive match.
- `error.rs` holds the error enums and `MAX_TOOL_ROUNDS`.

Things that are not obvious from a single file:

- **No `tools` array is sent to the server.** The server refuses a custom `grammar` when tools are present. Instead `provider/grammar.rs` builds a GBNF grammar from the enabled tool names each request: a thinking block closed by `</think>`, then plain text that cannot contain `<tool_call>`, or one call to an enabled tool. A disabled tool has no rule. Replies are parsed by hand in `parse_call`.
- **The chat template accepts one system message, at the start.** `provider/prompt.rs` builds the tool catalogue (every tool, enabled or not). `wire_messages` joins it into the first system message in each request only, so the history never changes when tools are toggled.
- **Changes that must reach the model travel in user messages.** The tool note (`[Tools enabled: ...]`) and a selected profile's text are prepended to the next user message when history does not already carry them. `prompt::is_announced` and `profile::carried` check the history, so compaction that removes them causes them to be sent again. Neither is stored in state.
- **Profiles** are `profiles/NAME.txt` under the working directory. An optional first line `tools: a, b` sets the enabled tools when the profile is selected; without it every tool is enabled. Names are validated against letters, digits, `-` and `_`.
- **Sessions** live in `sessions/sessions.db` (SQLite, via `rusqlite`): a `sessions` row per session and a `messages` row per message, ordered by `position`. `saved_sessions.rs` owns every read and write. `sessions/NAME.json` files from the old format are imported at launch by `saved_sessions::import` and left in place.
- **Reply cap.** Every request sets `max_tokens` (8192). Without it a reply whose thinking never closes runs indefinitely.
- **Commits** end with the `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>` line.

## Platform

Windows only. `run_powershell` starts `powershell.exe`, and `jobs.rs` stops process trees with `taskkill`. Paths in messages use backslashes.
