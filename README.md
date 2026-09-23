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
- `/save <name>` — save the current conversation as a named session at
  `.vise/sessions/<name>.json`.
- `/load <name>` — replace the current conversation with a saved session.
- `/sessions` — list saved session names.
- `/sessions delete <name>` — delete a saved session.
- `/sessions rename <old> <new>` — rename a saved session (fails if `<new>`
  already exists; delete it first to overwrite).
- `/new` — start a fresh conversation under the current profile.
- `/think` — list the configured reasoning levels and mark the current one.
- `/think <name>` — send that level's token budget as `reasoning_budget_tokens`
  (with `reasoning_budget_exact: true`) on every following request, until
  changed again. Levels come from `LLM_REASONING_LEVELS` in `.env.local`
  (`name:tokens` pairs, e.g. `low:512,medium:2048,high:8192,max:32768`, which
  is also the default when unset); a fresh session starts on `medium` when
  the table defines it. With the reasoning-budget-exact fork of llama.cpp,
  the model thinks exactly that many tokens; a plain llama.cpp server treats
  the field as a cap instead (the model may stop sooner), and other
  OpenAI-compatible servers may ignore it.

In the web UI (`bun run web`), the **sessions** panel below the header does
the same things with buttons instead of typed commands: a name field + Save,
and a Load/Rename/Delete row per saved session. Click the refresh icon to
load or update the list.

During a model turn, `ask_user` supports open-ended (`freeform`), single-choice
(`multiple_choice`), and multi-select (`multiple_select`) questions. Choice
questions show numbered options but accept a natural-language response, so you
can select listed options, add a custom answer, or do both. Only a line entered
after the question appears is used; lines typed earlier are discarded.
Subagents cannot prompt the user.

Tool calls are shown as they run, with the tool name, clipped argument
previews, completion status, and duration. Nested subagent calls are indented.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
