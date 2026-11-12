# Vise

Vise is a chat client for models served by OpenRouter or by a llama.cpp server. The model can read and edit files in the folder Vise is started from, run PowerShell commands (with your approval), use MCP tool servers, and run hook commands at the start and end of sessions and turns. It runs in the terminal or in a browser page.

## Requirements

- [Bun](https://bun.com).
- Windows. The file and command tools use PowerShell, and the folder dialog and the desktop window use Windows APIs.
- For the desktop window (`build:exe`): Rust and Cargo, and the WebView2 runtime, which Windows 11 includes.

## Setup

```bash
bun install
```

Vise reads its model providers from `.vise/providers.json` in the folder it is started from. Put it in your home folder instead to use the same providers in every folder. Each entry is an OpenRouter account or a llama.cpp server, with its own key:

```json
[
  { "kind": "openrouter", "name": "main", "apiKey": "<your OpenRouter key>" },
  { "kind": "llama.cpp", "name": "local", "url": "http://127.0.0.1:8080", "apiKey": "<the key the server expects>" }
]
```

Each provider's models are named `<name>::<id>`, for example `main::<model id>`. Keys are read only from this file, not from environment variables or `.env`. The `.vise/` folder is git-ignored because it holds keys.

## Running

```bash
bun run start       # terminal
bun run web         # browser page; prints a local address to open
bun run web:dev     # browser page, restarted when a file under src/ or index.ts changes
bun run build:exe   # build/exe/vise.exe, a window that shows Vise (needs Rust and Cargo)
```

Run `build/exe/vise.exe` from the folder you want to work in: the session works in the folder it is started from. Closing the window ends the session.

Type `/help` in a session to list its commands.

## Files Vise reads and writes

Settings live in `.vise/` in the working folder, and each one can also exist in the home folder, where an item of the same name in the working folder replaces the global one.

| Path | Holds | Written by |
| --- | --- | --- |
| `.vise/providers.json` | model providers and their keys | you, or the Providers panel |
| `.vise/mcp.json` | MCP tool servers | you, or the MCP panel |
| `.vise/hooks.json` | commands run at session and turn start and end | you |
| `.vise/tools.json` | tools switched off | `/tools` |
| `.vise/model.json` | the chosen model | `/model` |
| `.vise/sessions/` | saved conversations | `/save`, and autosave |
| `notes/<category>/<name>.md` | notes; a `profile` note holds custom instructions for the model | `/note`, and the file tools |
| `AGENTS.md` | instructions sent to the model at the start of every conversation | you |

## Documentation

- [AGENTS.md](AGENTS.md): commands for building, testing, and linting, the lint rules, and the code layout. Start here to change the code.
- [ARCHITECTURE.md](ARCHITECTURE.md): the design, its invariants, the security model, the known problems, and future work.
