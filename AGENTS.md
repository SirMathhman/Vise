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
- **The LLM client is the only module that calls `fetch`.** Both the chat
  request and the model catalog go through it.
- **Commands never reach the model.** `/`-lines are handled locally; their
  output is printed by the transport, never appended to the conversation.
- **Tools are the only modules that read/write the filesystem or spawn
  processes** during a turn. The documented exceptions: hook commands
  (`.hooks/` dir read + one spawn per invocation), `src/profiles.ts` (reads
  `.agents/*.md`), and `src/config/persist.ts` (writes `.env.local` on model
  select).
- **Session state (tracked processes) is created at the entry point and passed
  in** as a parameter — `tools.ts` holds no module-level mutable state.

## Conventions

- Biome handles lint + format (80-col, 2-space). See `biome.json`.
- TypeScript **strict** mode (`tsconfig.json`); keep it that way.
- **Line limits are enforced by review, not Biome** (function / file / directory
  limits; see ARCHITECTURE.md "Enforcement"). Don't split or trim code on your
  own initiative just to satisfy a size warning.
- Config is env-derived from `.env.local`; the model selector is the only writer
  of config back to disk.

## Where things live

- `index.ts` — entry point: builds `Config`, wires the REPL, runs.
- `src/llm/client.ts` — the single `fetch` site.
- `src/repl/loop.ts` — the turn loop (glue between input, conversation, client,
  commands, render, and hooks).
- `src/tools.ts` + `src/tools/*` — tool registry and per-tool handler submodules.
- `src/subagent.ts` + `src/tools/subagent.ts` — the `run_subagent` tool: nested
  isolated subagent conversations seeded from a profile's instruction.
- `.agents/*.md` — named **profiles** (personas); the built-in `agent` is the
  default. The file name is the profile name, the file content is the system
  instruction.
- `.hooks/{pre-session,pre-turn,post-turn}/*.cmd` — directory-based **hook
  commands** run at fixed points around turns.
- `src/config.ts` / `src/config/persist.ts` — env-derived config and the one
  disk writer.

## Working style

- Ask (via `vscode_askQuestions`) before changing how a documented feature
  behaves, or adding tests beyond what was asked — don't assume specs.
- Prefer the smallest change that satisfies the request; don't add surface
  area or features that weren't asked for.
- Commit often: after each plan phase and after any refactor, so the working
  tree handed back is clean.
