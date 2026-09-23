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

Built-in lines beginning with `/` are handled locally and are not sent to the
model. A slash-prefixed line matching a note name invokes that note as a
one-shot model turn; put the note name first, followed by optional
instructions.

- `/model` — list the models the server can serve, marking the current one and
  which are loaded.
- `/model <name>` — switch to `<name>`. The name must be one the server
  reports; unknown names are rejected. The choice is saved to `LLM_MODEL` in
  `.env.local` so it survives a restart. The conversation is kept.
- `/<note-name> <instructions>` — use `.vise/notes/<note-name>.md` as context
  for one request. For example, `/review check this implementation` invokes
  `.vise/notes/review.md` with the trailing request.

During a model turn, the `ask_user` tool can pause to ask one plain-text
question and wait for your answer. Only a line entered after its question
appears is used as the answer; lines typed earlier are discarded. Subagents
cannot prompt the user.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
