# vise

A Rust REPL that sends each line to a Strata server at `http://127.0.0.1:8080`.

To build and run:

```bash
cargo run
```

Type `exit` or `quit` to leave the REPL.

## Web UI

Install the TypeScript and watcher tools once:

```bash
npm install
cargo install cargo-watch
```

Then start the web UI in watch mode. Changes to `.rs` and `.ts` files rebuild the page and restart the server:

```bash
npm run dev
```

Open `http://127.0.0.1:3000`. Refresh the browser yourself after a restart.

To build the page once without watching:

```bash
npm run build
```
