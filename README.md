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

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
