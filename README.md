# vise

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

To run the web UI (frontend + backend on http://localhost:3000):

```bash
bun run web
```

## Commands

Built-in lines beginning with `/` are handled locally and are not sent to the
model. A slash-prefixed line matching a note name, or (if there's no note of
that name) a profile name, invokes it as a one-shot model turn; put the name
first, followed by optional instructions. The active profile is unchanged —
use `/profile <name>` to switch it for the rest of the conversation instead.

- `/model` — list the models the server can serve, marking the current one and
  which are loaded.
- `/model <name>` — switch to `<name>`. The name must be one the server
  reports; unknown names are rejected. The choice is saved to `LLM_MODEL` in
  `.env.local` so it survives a restart. The conversation is kept.
- `/<note-name> <instructions>` — use `.agents/notes/<note-name>.md` as context
  for one request. For example, `/review check this implementation` invokes
  `.agents/notes/review.md` with the trailing request.
- `/<profile-name> <instructions>` — when no note has that name, use
  `.agents/<profile-name>.md`'s instruction as context for one request
  instead, without switching the active profile. For example,
  `/plan add a dark mode toggle` runs one turn under the `plan` profile.

During a model turn, `ask_user` supports open-ended (`freeform`), single-choice
(`multiple_choice`), and multi-select (`multiple_select`) questions. Choice
questions show numbered options but accept a natural-language response, so you
can select listed options, add a custom answer, or do both. Only a line entered
after the question appears is used; lines typed earlier are discarded.
Subagents cannot prompt the user.

Tool calls are shown as they run, with the tool name, clipped argument
previews, completion status, and duration. Nested subagent calls are indented.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
