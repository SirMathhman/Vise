# vise

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

To use it in a browser instead of the terminal (prints a local URL to open):

```bash
bun run web
```

To develop the browser frontend, `bun run web:dev` restarts the server whenever a file under `src/` or `index.ts` changes. Each restart starts a new session, on the same address, so an open page reconnects by itself.

To build a Windows program, `build/exe/vise.exe`, that shows Vise in a WebView2 window (needs Rust and Cargo, and the WebView2 runtime, which Windows 11 includes):

```bash
bun run build:exe
```

Run `build/exe/vise.exe` from the project folder: the session works in the folder it is started from, and reads `.env` from there. Closing the window ends the session.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
