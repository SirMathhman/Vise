# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` (imported above) is the authoritative description of the product surface, the hard rules and the current-state notes; `ARCHITECTURE.md` has the design rationale and target layout. Read those before structural changes. This file adds only what is quickest to get wrong.

## Commands

Bun runtime, TypeScript, no build step for server/core.

```bash
bun test                                   # all suites (test/)
bun test test/repl/session.resume.test.ts  # one file
bun test -t "resume re-applies"            # by test name
bunx tsc --noEmit                          # server/core/tests (excludes web/ and extension/)
bun run typecheck:web                      # browser code (web/tsconfig.json)
bun run typecheck:ext                      # Firefox extension
bun run lint                               # also enforces file (500) and function (100) size, code lines only
bun run web                                # build the page bundle and serve it (PORT overrides 3000)
bun run dev:web                            # rebuild on web/src changes, restart the server
bun run index.ts                           # the terminal REPL
```

A change is done when tsc, `typecheck:web`, lint and `bun test` pass; they are all clean on main.

## Things that bite

- **Size and layout limits are tests/lint, not advice.** A directory holds at most 9 `.ts` files directly (`test/layout.test.ts`, applies to `test/` too: use a sub-directory); files stay under 500 code lines and functions under 100 (`bun run lint`).
- **The web page and the server share pure modules.** `web/src` imports value modules from `src/` (`src/core/...`, `src/repl/command-catalog.ts`, `src/repl/lists.ts`). Those must not use `node:` APIs or read `location`/`document` at module load (tests import them without a DOM).
- **Adding a slash command** means one entry in `src/repl/command-catalog.ts` plus its handler in `Session.commands`; a test fails when they disagree. Help, the page's suggestions and reserved names derive from the catalog.
- **Adding a tool** means a definition in `src/tools/defs/` (set `core`, `defaultDisabled`, `requiresFileSystem` and so on on the definition itself, never in a name list), a handler registered in `src/tools.ts`, and a failing path that returns an `error:` string (use `errStr`). A new browser engine capability goes in `BrowserBackend.capabilities`.
- **Page state comes from the server as data.** The header, tools panel and session menu are filled from the `lists` message; do not parse command output text on the page.
- **Message routing for the page is one table** (`src/web/router/router.ts`); put a new message type there with exact types before prefixes.
- **Windows and line endings.** Sources are a mix of LF and CRLF; edit with tools that preserve each file's endings. `run_powershell` is the only shell tool and is Windows-only.
- **Do not start a second `llama-server`** (check port 8080 first), and do not run `bun run build:exe` or kill vise/bun processes casually: the live exe is renamed aside by the build, and `run_powershell` refuses self-kill commands.
- **Opening the web page on this repo resumes your latest saved session** (and its running state), so verify UI changes against a scratch folder with `?root=<path>` rather than the project root.
