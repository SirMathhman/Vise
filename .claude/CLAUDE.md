# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The full guidance (commands, lint rules, architecture) lives in `AGENTS.md` at the repo root and is the source of truth. Read it first. This file only adds what it does not cover.

## Where things are

- `ARCHITECTURE.md` is the target design, not a description of the current code. Its "Known Problems" section lists the gaps. Check it before assuming a module does what the document says.
- `.vise/` holds local settings, the MCP servers file, hooks, and saved sessions. It is gitignored and can contain header values, so do not commit it or paste its contents into output.
- `notes/` is the user's own data (notes and profiles) and is read at runtime. Do not edit it unless the task is about notes.
- The root directory already holds the maximum of 10 tracked files that `scripts/check-files-per-dir.ts` allows. Put new root-level docs elsewhere, or `bun run lint` fails.
