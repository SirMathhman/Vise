# Agent Instructions

**Vise** is a Bun + TypeScript REPL for a llama.cpp OpenAI-compatible server.
The model is the product; everything else is plumbing around it.

## Commands

- `bun install` — install dependencies.
- `bun run start` (or `bun index.ts`) — run the REPL.
- `bun lint` — Biome check (lint + format).

There is no build step (Bun runs TypeScript directly) and no test framework is
set up yet. `npx madge --extensions ts src/ index.ts` should report no
dependency cycles; run it after touching module boundaries.

## Architecture

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing module boundaries. It is
aspirational — it points ahead of the code — but its **invariants** are the hard
rules to respect:

- **Dependency direction is sacred.** `src/llm/*` must not import `src/repl/*`
  (llm is the lower layer — `src/repl/*` imports from `src/llm/*`, never the
  other way around); the `src/tools/*` submodules must not import each other
  (`src/tools.ts` is their only importer). No cycles — verify with
  `npx madge`.
- **The LLM client is the only module that calls `fetch`.** The chat
  request, the model catalog, and the context-size lookup (`GET /props`)
  all go through it.
- **Commands never reach the model.** `/`-lines are handled locally; their
  output is printed by the transport, never appended to the conversation.
  The commands today are `/model`, `/profile`, `/tool`, `/tools`, `/context`,
  and `/compact`.
- **Tools are the only modules that read/write the filesystem or spawn
  processes** during a turn. The documented exceptions: hook commands
  (`.hooks/` dir read + one spawn per invocation), `src/profiles.ts` (reads
  `.agents/*.md` and `AGENTS.md`; `createProfile` also writes
  `.agents/<name>.md` on `/profile new`), `src/config/persist.ts` (writes
  `.env.local` on model select), and `src/session.ts` (reads/writes
  `.vise/session.json` at turn boundaries — load on startup, save after each
  turn — so the conversation, active profile, and tools flag survive a
  restart).
- **Session state (tracked processes) is created at the entry point and passed
  in** as a parameter — `tools.ts` holds no module-level mutable state.
- **Notes are a file convention, not a tool or command.** Memories and skills
  are unified as plain `.vise/notes/*.md` files the model and the user read
  and write with the regular file tools; there is no note tool and no `/note`
  command. The short index (name — summary per note) is injected at the
  beginning of the system prompt at startup and rebuilt by compaction; the
  full content is read on demand with `read_file`.

## Conventions

- Biome handles lint + format (80-col, 2-space). See `biome.json`.
- TypeScript **strict** mode (`tsconfig.json`); keep it that way.
- **Line limits are enforced by review, not Biome** (function / file / directory
  limits; see ARCHITECTURE.md "Enforcement"). Don't split or trim code on your
  own initiative just to satisfy a size warning.
- Config is env-derived from `.env.local`; the model selector is the only
  writer of config back to disk. The env vars: `LLM_BASE_URL`
  (default `http://localhost:8080`) and `LLM_MODEL` (default `local`) are the
  only ones with defaults; `LLM_EMBED_MODEL` falls back to `LLM_MODEL`;
  `LLM_API_KEY` and the `PRE_SESSION_CMD` / `PRE_TURN_CMD` / `POST_TURN_CMD`
  (+ `_PROFILES`) hook vars are optional.

## Where things live

- `index.ts` — entry point: builds `Config`, wires the REPL, runs.
- `src/llm/client.ts` — the single `fetch` site.
- `src/repl/loop.ts` — the turn loop (glue between input, conversation, client,
  commands, render, and hooks).
- `src/repl/compact.ts` — conversation compaction: one non-streaming,
  tool-free model call collapses the whole conversation into a summary.
  Triggered automatically once usage crosses 80% of the server's context
  window (skipped if the server doesn't report one), or manually via
  `/compact`. Deliberately a single rare collapse rather than an incremental
  trim, so it invalidates the server's KV-cache prefix once instead of every
  turn.
- `src/tools.ts` + `src/tools/*` — tool registry and per-tool handler submodules.
- `src/subagent.ts` + `src/tools/subagent.ts` — the `run_subagent` tool: nested
  isolated subagent conversations seeded from a profile's instruction.
- `src/llm/vectors.ts` + `src/tools/semsearch.ts` — semantic search: chunks
  and embeds project files into a SQLite index at `.vise/vectors.db`
  (re-indexed at startup, not during a turn), queried by the `semsearch`
  tool.
- `.agents/*.md` — named **profiles** (personas); the built-in `agent` is
  the default. The file name is the profile name, the file content is the
  system instruction (an optional `tools:` line whitelists tools).
- `.hooks/{pre-session,pre-turn,post-turn}/*.cmd` — directory-based **hook
  commands** run at fixed points around turns.
- `.vise/notes/*.md` — **notes**: the unified memories-and-skills file
  convention. Filename is the note's name, a `summary:` line feeds the short
  index, the rest is the note's content. Injected into the system prompt by
  `src/notes.ts`.
- `src/config.ts` / `src/config/persist.ts` — env-derived config and the one
  disk writer.
- `src/session.ts` — session persistence: loads/saves `.vise/session.json`
  (the conversation, active profile, and tools flag) so a restarted REPL
  resumes where it left off.

## Working style

- Ask (via `vscode_askQuestions`) before changing how a documented feature
  behaves, or adding tests beyond what was asked — don't assume specs.
- Prefer the smallest change that satisfies the request; don't add surface
  area or features that weren't asked for.
- Commit often: after each plan phase and after any refactor, so the working
  tree handed back is clean.
