# vise

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## Commands

Lines beginning with `/` are handled locally and are not sent to the model.

- `/model` — list the models the server can serve, marking the current one and
  which are loaded.
- `/model <name>` — switch to `<name>`. The name must be one the server
  reports; unknown names are rejected. The choice is saved to `LLM_MODEL` in
  `.env.local` so it survives a restart. The conversation is kept.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
