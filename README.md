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
