# vise

A Rust REPL that sends each line to a Strata server at `http://127.0.0.1:8080`.

To build and run:

```bash
cargo run
```

Type `exit` or `quit` to leave the REPL. These commands work in the REPL and in the web UI:

- `/new` starts a fresh conversation. (The web UI has a New button instead.)
- Ctrl+C in the REPL stops a running reply. A second Ctrl+C quits. The web UI's Stop button does the same. A stopped reply stays on screen, but it is not kept in the conversation.
- `/tools` lists each tool as on or off.
- `/disable <tool>` and `/enable <tool>` switch a tool off or on for this session only: this REPL, or this browser tab. Other tabs and other REPL runs are not affected. A tool that is off cannot be called. Strata is also asked not to generate calls to it.
- The web UI has a Tools panel beside the chat. It lists every tool with its description and an on/off switch. A switch there works like `/enable` and `/disable` for this browser tab, and it applies from the next message. Drag the divider between the chat and the panel to change the panel's width; the width is remembered in this browser.
- `/notes` lists every note as `scope category/name`. `/notes <scope>/<category>/<name>` shows one note in full, where scope is `local` or `global`.
- The web UI renders the model's replies, tool descriptions and note summaries as markdown. Raw HTML in them shows as text. A note's editor has a Preview button that shows its markdown. The markdown libraries load from cdnjs, so the formatting needs a network connection; without one, the text still shows, unformatted.
- The web UI has a Notes section under the Tools list. It lists notes from both scopes and opens one in an editor. You can create, edit and delete notes there. Edits made in the UI reach the model at the start of its next conversation, not in the current one.
- `/save <name>` writes the conversation to `.vise/sessions/<name>.json` in the working directory, replacing any session saved under that name. `/load <name>` replaces the conversation with a saved one, and `/sessions` lists the saved names. The web UI's Sessions panel does the same. A saved session keeps the messages and the switched-off tools the model was told about. It does not keep the tool switches themselves, so a loaded conversation announces any difference from the switches as they are now.
- Clicking a text file in the Files panel opens its contents in a viewer in a column beside the chat. Each click opens another viewer, one per file, and each viewer has its own Close. Close all clears them all. Files that are not UTF-8 text are refused, and paths outside the working directory are refused.
- The web UI's Files panel shows the tree of the working directory. Folders start closed and open when clicked, and Refresh reloads the tree. `.git`, `target` and `node_modules` are left out, and a tree of more than 2000 entries is cut short.
- The model can run a subagent with the `run_subagent` tool. It names a profile (`local/<category>/<name>` or `global/...`) and a task. The subagent runs in a fresh conversation with the profile's instructions and only the tools the profile lists, and the tool returns its final answer. A subagent cannot start another one. In the web UI each run is a block that is open while it runs and folds away when it finishes; in the REPL its steps print indented under a `[subagent ...]` line. Stopping the turn stops the subagent too.
- Each completed turn is saved automatically. The first completed turn of a conversation picks a name like `auto-1793000000000`, and later turns overwrite that session. `/new` and the web New button start a new conversation with a new name, and `/load` makes the next completed turn save under a new name, so a loaded session is not overwritten. A failed or stopped turn is not saved.
- A built-in default profile is applied at the start of each conversation: the REPL at startup and on `/new`, and the web UI on load and New. `/profile default` applies it again. It currently leaves the tools and the conversation unchanged; its settings are in `src/commands.rs`.
- A profile is a note with `profile: true` and an optional `tools: list_files, read_file` line in its frontmatter. `/profile <scope>/<category>/<name>` chooses one, or pick it from the web UI's Profile list. Its tools go on, and every other tool goes off. Its text is added to the conversation as instructions. `/new` clears the instructions, but the tools stay as the profile set them.

Strata must be running at `http://127.0.0.1:8080`. Replies stream, and a model reply can call the file tools
(`list_files`, `read_file`, `create_file`, `create_directory`, `delete_file`, `delete_directory`). Those tools only act
inside the directory the program was started in. Long conversations are summarized automatically, and the summary
keeps the conversation going without rewriting its history.

Notes are Markdown files at `.vise/notes/<category>/<name>.md`. Local notes sit in the working directory. Global notes sit
in the home directory (`~/.vise/notes`) and are shared by every project. The model can list, read, create, edit and
delete both kinds (`list_notes`, `read_note`, `create_note`, `edit_note`, `delete_note`). Each of the tools takes a
`scope` of `local` (the default) or `global`. A note's text is sent
to the model only when it reads the note. A note must start with frontmatter giving `name` and `summary`, between `---`
lines, to be created. At the start of each conversation, the model also gets a list of the notes that have frontmatter,
each with its summary, local and global alike. Notes without frontmatter are not listed. The user can list and show notes
with `/notes`; writes are made by the model.

```
---
name: plan
summary: Steps for the import rewrite
---
The text of the note.
```

To serve the web UI from Rust, without the watch tools:

```bash
cargo run -- web
```

The web UI is then at `http://127.0.0.1:3000`.

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

If a TypeScript change fails to compile, the error stays in the terminal and the server keeps the previous build. Refreshing the page then shows the old version.

To build the page once without watching:

```bash
npm run build
```
