# vise

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

To build the executables (`out/vise.exe` serves the web UI, `out/vise-cli.exe` is the terminal REPL):

```bash
bun run build:exe
```

Both need a llama.cpp server on port 8080 (not included). Settings are edited in the web UI and stored in `~/.vise/.env`; to update, replace the exe. Extra commands: `--version`, `--install-extension` (Firefox extension to `~/.vise/extension`), `--setup-playwright` (only for the optional `browser_run_code` tool).

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
