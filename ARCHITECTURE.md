# Vise — Architecture

The ideal architecture this project is working toward. This document points ahead of
the code; it is not a changelog. Progress lives in the git log.

## Definitions

- **Turn** — one user message plus the model's reply to it. A turn is the unit of
  state that accumulates in a conversation.
- **Reply rendering** — the streaming display of a model reply to the user, as
  distinct from the reply's accumulation in the conversation. The client emits
  content deltas through a callback as they arrive; the turn loop renders each
  delta to the terminal in real time. The conversation still accumulates the
  full reply before the next turn (Future Work).
- **Thinking display** — the bounded, one-line display of the model's
  reasoning (the `reasoning_content` deltas that precede a reply on reasoning
  models). Because reasoning can be arbitrarily long, the display never shows
  the reasoning text itself: it repaints a single line with an elapsed time and
  a running token estimate while the model thinks, then settles into a one-line
  "thought" marker when the answer (or a tool call) begins. The reasoning is
  also preserved on the assistant message (`reasoning_content`) so the model
  can see its own prior thinking on the next turn; the server round-trips the
  field, though individual templates may or may not honor it.
- **Prefill display** — the bounded, one-line live display of the server's
  prefill (prompt-processing) phase, shown before any token is generated
  (prompt -> prefill -> decode). Driven by llama.cpp's `return_progress`
  stream chunks: while prefill runs, the transport repaints a single line
  with an elapsed time and the new-token progress fraction (prefilled-so-far
  over total-new, alongside the cached count), then settles into a one-line
  "prefilled" summary when the first reasoning or content delta begins. This
  is the single prefill summary per turn; there is no separate post-answer
  prefill line. As with the thinking indicator, it is a plain \r repaint,
  inert when the server doesn't report `prompt_progress` (older builds), and
  never shows prompt text — only token counts and timing. The live progress
  is observed through the same `onPrefill` callback the LLM client exposes,
  so it is wired by the caller (the main REPL) and not by subagents.
- **Reasoning budget / level** — a request-level override of how long the
  model reasons, selected at runtime with `/think <name>` and sent as
  `reasoning_budget_tokens` + `reasoning_budget_uniform: true` on every
  following request (uniform mode, on the user's llama.cpp fork: reasoning is
  force-closed at a uniformly random length within the budget unless the
  model ends it sooner, rather than the budget acting as a plain cap). A
  **level** is a `{ name, tokens }` pair from `Config.reasoningLevels`,
  parsed from `LLM_REASONING_LEVELS` (`name:tokens,...`; built-in defaults
  when unset — see `src/config.ts`). Until a level is chosen, or once
  `/think <name>` targets a name the table doesn't define, no budget field is
  sent and llama.cpp's startup `--reasoning-budget` governs the completion
  instead. A fresh session starts on the level named by
  `DEFAULT_REASONING_LEVEL` (`"medium"`) when the table defines it. Because
  reasoning can run all the way to the budget, the budget actually sent
  is capped at the free context (context size minus tokens used minus an
  answer reserve), recomputed every tool round; "tokens used" is the server's
  last reported count plus an estimate of the messages appended since, and
  the whole conversation is estimated when no count exists yet (fresh,
  restored, loaded, or compacted). Otherwise a budget larger than the space
  left would fill the window mid-thought and leave no answer. The one
  exception is `compactConversation`'s summary request, which always sends
  `reasoning_budget_tokens: 0` regardless of the active level — summarizing
  is a mechanical extraction task, not one that benefits from reasoning.
- **Conversation** — the ordered, in-memory sequence of turns (user + assistant
  messages) sent to the model on every request. It is the REPL's source of truth
  for context.
- **LLM client** — the single module that knows the wire protocol
  (OpenAI-compatible `POST /v1/chat/completions` against llama.cpp). Everything
  else talks to the model through this module and nothing else.
- **Transport** — how stdin is read and how output is rendered (prompts,
  assistant replies, errors). Swappable, and the only module allowed to touch
  `process.stdin`/`process.stdout`.
- **Config** — the typed, env-derived settings object (base URL, model, API
  key, pre-session command, pre-turn command, post-turn command). Constructed
  once at startup. Read-only everywhere except the model selector, which owns
  the one mutable field (`model`) and is the only writer of config back to
  disk.
- **Command** — a built-in line beginning with `/` that the REPL handles
  locally and never sends to the model. A command handler receives its
  arguments and explicit context, returns a result for the loop/renderer to
  apply, and does not read input or print directly. Context capabilities may
  perform effects (for example, model listing, profile creation, or session
  persistence); keep those effects explicit and do not let handlers import
  the transport or call `fetch` themselves.
- **Model catalog** — the set of models the server reports at `GET /v1/models`,
  each with a load status. The catalog is the authority for what a model name
  may be; the selector never accepts a name the catalog does not contain.
- **Model selector** — the single owner of the active model name. It reads the
  catalog, validates a requested name against it, updates the in-memory value,
  and persists the choice. Nothing else may mutate the active model.
- **Tool** — a function the model can call (e.g. `read_file`, `edit_file`,
  `run_powershell`) to act on the filesystem or execute external processes.
  During a turn, tools are the only modules permitted to read or write files
  or spawn subprocesses (hook commands are the only exception, see
  invariant 5); they never call `fetch` and never touch the conversation
  directly — they return a string result that the loop appends as a
  `role: "tool"` message.
- **Interactive question tool** — `ask_user` pauses a main REPL model turn,
  supports free-form, single-choice, and multi-select prompts through a
  transport-owned callback, and returns the next freshly entered line as the
  tool result. Choice prompts display options but accept natural-language
  responses, including custom text. Subagents never receive this tool and
  cannot prompt the user. Its JSON Schema constrains question types and
  requires options only for choice modes; runtime validation remains required.
- **Tool-call display** — the main REPL observes tool dispatch through an
  optional `ToolContext` callback. The transport renders tool name, clipped
  argument previews, nested depth, final status, and elapsed time; tool results
  and full argument values are not printed by this display. Observer failures
  are swallowed so the visualization cannot affect dispatch or handler results.
- **Tracked process** — a background subprocess the model started without
  awaiting to completion, identified by a process ID. Its accumulated
  stdout/stderr, exit code, and liveness are kept for the rest of the
  session so `wait_for_process` and `kill_process` can act on it later.
- **Profile** — a named set of custom system instructions (a persona).
  Profiles come from two sources: a built-in "Agent" default and file-based
  profiles from `.agents/*.md` in the working directory. Every profile's
  instruction is composed from the codebase's agent instructions (`AGENTS.md`
  in the working directory, when present) plus the profile's own instruction
  (for the built-in agent, the CWD message), so the model receives the
  codebase's agent instructions in the system prompt regardless of which
  profile is active. Switching profiles appends a new system message to the
  conversation; existing history is never altered.
- **Note** — a plain markdown file at `.agents/notes/<name>.md` in the
  working directory. Notes are how memories and skills are unified: there is
  no type distinction, a note is simply a fact, decision, or how-to the model
  wants to keep across sessions. The filename (minus `.md`) is the note's
  name; a `summary: <one line>` line near the top is its one-line
  description; the rest of the file is its content. Users and the model
  maintain notes with the regular file tools (`read_file`, `create_file`,
  `edit_file`); `/note new <name>` scaffolds an empty template without
  overwriting existing notes, and there is no dedicated note tool. A
  slash-prefixed input matching a note name, after built-in commands are
  resolved, starts a one-shot model turn: the note content and trailing
  instructions become the user input and pass through the regular pre-turn
  hooks, model/tool flow, and post-turn hooks. When no note matches, the same
  slash-prefixed input is tried against profile names instead: a match runs
  one turn using that profile's instruction (composed the same way
  `/profile <name>` composes it) as context, without switching the active
  profile — `/profile <name>` remains the only way to change it persistently.
  This on-demand lookup is a read-only filesystem exception
  performed by `src/notes.ts` and `src/profiles.ts` (invariant 5). The short index
  (a `name — summary` line per note, preceded by a "Current notes:" header)
  is injected at the beginning of the system prompt at startup and rebuilt
  by compaction; it is static for a session. Notes created or edited
  mid-session appear in a newly initialized conversation. On session
  restoration, only the generated index prefix in system messages is
  refreshed from the current note registry; conversation text is preserved,
  and note files are not migrated. The notes convention is explained in
  AGENTS.md (always in the system prompt via
  `composeInstruction`), so the runtime header only lists what notes
  currently exist rather than re-explaining the convention. `.vise/` is
  reserved for generated runtime state; legacy `.vise/notes/` files are not
  migrated or read.
- **Hook command** — a shell command that runs at a fixed point around turns.
  Hooks come from two sources: env-var config (`PRE_SESSION_CMD`,
  `PRE_TURN_CMD`, `POST_TURN_CMD`) and directory-based hooks
  (`.hooks/<type>/*.cmd` files, where `<type>` is `pre-session`, `pre-turn`,
  or `post-turn`; each file's trimmed content is a command, files run in
  alphabetical order). Env-var hooks run first, followed by directory hooks;
  all hooks run regardless of prior failures (continue-on-error semantics).
  The pre hooks print their combined stdout+stderr and append it to
  the conversation as a system message when output is non-empty, on success
  or failure. The post hook is silent on success (neither printed nor appended,
  so a passing check never pollutes context) and, on failure (non-zero exit),
  prints the output as a warning and appends it as a system message so the
  model sees it on the next turn. Unlike tools, hooks are driven by config
  rather than by the model, and they run at fixed points rather than on demand.
  Each hook can optionally be scoped to specific profiles via a whitelist:
  directory hooks declare this on a `# profiles: a,b,c` first line in the
  file, and env-var hooks via a companion `*_PROFILES` env var
  (e.g. `PRE_TURN_CMD_PROFILES=agent,reviewer`). A hook with no whitelist
  runs for all profiles.

**Invariants:**

1. The LLM client must never import from the transport, and the transport must
   never import from the LLM client. All cross-cutting state (conversation,
   config) flows _down_ from the entry point, never sideways between those two
   modules.
2. The LLM client is the only module that calls `fetch`. The model catalog is
   fetched through the client, not beside it.
3. Built-in commands never reach the model. Their rendered output is printed
   by the transport, never appended to the conversation. A command may request
   a state change via its result (e.g. `setModel` changes the active model,
   `setProfile` causes the loop to append a new system message carrying the
   profile's instruction); the loop applies these side effects. A profile
   switch appends a new system message but never alters existing history.
4. The active model is read at request time, not captured at startup, so a
   switch takes effect on the next turn without rebuilding the client.
5. Tools are the only modules that read or write the filesystem or execute
   external processes during a turn. The hook system is the primary exception:
   `src/repl/hooks.ts` reads the `.hooks/<type>/` directory at startup to
   discover directory-based hooks (read-only filesystem access, no
   subprocesses), and `src/repl/presession.ts` (to be renamed `externalcmd.ts`,
   see Future Work) spawns exactly one subprocess per hook invocation. A small
   set of documented non-tool FS readers/writers also exist outside the
   tools, all at startup or turn boundaries (never during a tool call):
   `src/notes.ts` reads a matching `.agents/notes/<name>.md` on demand for a
   named-note invocation, creates a template during `/note new`, and builds
   the startup note index;
   `src/profiles.ts` reads `.agents/*.md` and `AGENTS.md` and writes
   `.agents/<name>.md` on `/profile new`; `src/config/persist.ts` writes
   `.env.local` on model select; and `src/session.ts` reads/writes
   `.vise/session.json` (load on startup, save after each turn) so the
   conversation, active profile, and tools flag survive a restart, and
   reads/writes `.vise/sessions/*.json` for named session snapshots
   (written by `/save`, read by `/load`). Neither
   the tools nor the hook modules call `fetch` or touch the conversation
   directly; tools return a string result that the loop appends as a
   `role: "tool"` message, and the loop appends hook output as a
   `role: "system"` message (pre hooks when output is non-empty; the post
   hook only when it exits non-zero, per the hook command definition).
6. Session-long state (the set of tracked processes) is created at the entry
   point and passed to tools as a parameter — the same pattern as commands
   receiving the client. `tools.ts` holds no module-level mutable state.
7. Interactive input is transport-owned. The main REPL supplies a typed
   callback to `ask_user` supporting free-form, multiple-choice, and
   multiple-select questions. Choice prompts accept natural-language answers,
   including custom text; tool handlers never read stdin or print prompts,
   and subagents have no user-input callback.
8. Tool-call visualization is observational: it must not alter tool arguments,
   results, dispatch order, or conversation messages. Subagent tool calls may
   reuse the observer, with nesting represented by depth.

## Structure

Module layout and dependency direction (each directory/file below is a real,
split-on-demand module; terminal and web entry points share the same REPL core):

```
index.ts              terminal entry point: build Config, wire terminal Transport + Repl
web.ts                web entry point: build Config, start the HTTP/WebSocket server
src/config.ts         read env -> typed Config. No I/O beyond reading env, no
                        fetch. Also defines ReasoningLevel ({ name, tokens })
                        and parses LLM_REASONING_LEVELS into Config.reasoningLevels
                        (built-in low/medium/high/max when unset); throws at
                        startup on a malformed entry rather than silently
                        dropping a level.
src/config/persist.ts rewrite a single key in .env.local. The only module that
                        writes config to disk; takes a path + key + value.
src/llm/types.ts      Pure wire-protocol and shared-shape types; no I/O, no
                        imports of any handler module. Message, ChatMessage,
                        ChatCompletionRequest/Response, Tool, and ToolContext
                        shapes. ToolContext.tracker is typed as a structural
                        ProcessTracker interface defined here (the methods a
                        tool handler calls: spawn/get/remove/shutdown) rather
                        than importing the ProcessTracker class from
                        tools/process.ts; that keeps this module a leaf and
                        breaks the tools/* <-> llm/types.ts circular
                        dependency. The ProcessTracker class in tools/process.ts
                        satisfies the interface structurally.
src/llm/client.ts     LLM client: takes Config + messages, returns a structured
                        result. The ONLY place fetch() is called.
                        chatCompletionStream and chatCompletion both take an
                        optional reasoningBudget (tokens); when set, sends
                        reasoning_budget_tokens + reasoning_budget_uniform: true
                        on that one request, in uniform mode; omitted, the
                        server's own --reasoning-budget governs instead. The
                        turn loop passes the caller's chosen /think level;
                        compact.ts always passes 0 (see "Reasoning budget /
                        level").
src/llm/turns.ts      Shared model/tool-round protocol for the REPL and
                        subagents. Repeatedly calls chatCompletionStream,
                        appends assistant tool-call messages (including
                        reasoning_content) and tool results, and appends the
                        final assistant reply. Takes a dispatch callback,
                        optional stream observers, and an optional
                        ReasoningBudget; before every round it caps the budget
                        at the free context (effectiveReasoningBudget: context
                        size - tokens used - an answer reserve, floored at 0),
                        using the last reported usage plus a conservative
                        estimate (estimateTokens, 3 chars/token) of every
                        message appended since -- tool results, the new user
                        message, hook output -- so tool rounds that grow the
                        conversation shrink the budget; owns no presentation,
                        hooks, or filesystem/process access.
src/llm/models.ts     model catalog: list models via the client, validate a name
                        against the catalog. No fetch of its own.
src/llm/vectors.ts    vector index over project files: chunks each non-ignored
                        file into ~800-char blocks, embeds them through the
                        client's embeddings() helper (the only fetch path,
                        invariant 2), and stores chunks + embeddings in a
                        SQLite DB at .vise/vectors.db. Re-embeds only files
                        whose mtime/size changed; prunes files that vanished
                        or became gitignored. Respects .gitignore via
                        `git ls-files`, with a manual-walk fallback when git
                        is unavailable. Exposes ensureIndexed(config) and
                        semanticSearch(config, query, k). The one
                        documented non-tool module that touches the
                        filesystem and spawns a subprocess (invariant 5):
                        ensureIndexed runs at startup from the entry point
                        (loop.ts), before the first turn, so it is outside
                        "during a turn"; the tool handler semsearch.ts is
                        the in-turn consumer.
src/profiles.ts       profile registry: list and look up profiles. Profiles
                        come from the built-in Agent default plus .agents/*.md
                        files in the CWD. Reads AGENTS.md once at startup and
                        composes its content into every profile's instruction
                        (a documented FS-exception, invariant 5), so the model
                        receives the codebase's agent instructions in the
                        system prompt for any active profile. No mutable state,
                        no fetch, no stdin/stdout.
src/notes.ts          note registry + notes intro. Notes unify memories and
                        skills as plain .agents/notes/<name>.md files the model
                        and user maintain with the regular file tools, with
                        `/note new <name>` as a template-creation command (no
                        dedicated note tool). listNotes()/getNote()/createNote()
                        resolve the .agents/notes/ directory; getNote() reads a
                        matching note on demand, and createNote() creates a
                        summary template without overwriting (read/write FS,
                        invariant 5, like profiles.ts).
                        withNotesIntro() builds the short `name — summary`
                        index once at module load and prepends it to the
                        profile's instruction so the notes list sits at the
                        beginning of the system prompt (loop.ts seeds it,
                        compact.ts and profile switches rebuild it). No
                        mutable state, no fetch, no stdin/stdout.
src/transport.ts      Pure types: the swappable `Transport` seam between the
                        core turn loop and a concrete frontend (terminal or
                        browser today; a TUI or remote frontend later). Declares the input methods
                        (nextLine/nextFreshLine/close), the one-shot renders
                        (prompt/question/toolCallStart/toolCallEnd/command/
                        error/hook/compactNotice), the per-completion stateful
                        handle factories (replyStream/thinkingIndicator/
                        prefillIndicator), and a `log` diagnostics channel for
                        housekeeping messages ([compact] .../ [index] ...).
                        The core (loop.ts) depends only on this interface and
                        never touches stdin/stdout directly. No I/O; no import
                        of any handler module.
src/web/protocol.ts   Pure WebSocket message unions for browser/server frames.
                        The browser client mirrors these shapes in plain JS;
                        validate all received frames at runtime because the
                        network boundary is untrusted.
src/web/webTransport.ts  Browser-backed `Transport` implementation. Maps
                        WebSocket input frames to line-queue operations and
                        transport render calls to server frames. No fetch or
                        direct filesystem access.
src/web/server.ts    Web entry-point server: serves the static client and
                        owns the single active WebSocket REPL session. The
                        server adapts the socket to `WebTransport` and calls
                        the shared `run(config, transport)`; it is not imported
                        by the core loop or the terminal entry point. The
                        session outlives any one socket: a disconnect only
                        detaches it (a reload reattaches); only an explicit
                        client `close` frame ends `run()`.
web/                  Static browser client (HTML, CSS, vanilla JS). Owns DOM
                        rendering and WebSocket connection behavior; it never
                        calls the model server directly.
src/repl/input.ts     stdin buffering (line queue + nextLine + nextFreshLine).
                        nextFreshLine discards already-buffered input and waits
                        for a new answer line. No fetch, no other state.
src/repl/render.ts    prompt, question, tool-call, error, hook, command rendering
                        plus the reply-stream, thinking-indicator, and
                        prefill-indicator handles (createReplyStream,
                        createThinkingIndicator, createPrefillIndicator), which
                        own the terminal state for a streamed answer and one
                        model completion's bounded "thinking" line and live
                        "prefilling" line respectively. Pure formatting; no
                        fetch; no import from llm/types.ts.
src/repl/terminalTransport.ts  the terminal implementation of the Transport
                        seam (src/transport.ts). Delegates to input.ts for
                        stdin and render.ts for stdout, so terminal behavior
                        is unchanged. A future web UI or TUI provides a
                        different implementation of the same Transport
                        interface and is handed in from the entry point. No
                        fetch; no import from llm/types.ts.
src/repl/commands.ts  the command registry: parse a `/` line, dispatch to a
                        handler, return a result. No fetch, no stdin/stdout.
                        /think lists CommandContext.reasoningLevels (marking
                        the current one) with no argument, or returns
                        setReasoningLevel with a known name; an unknown name is
                        an error listing the table. Pure lookup against the
                        table the entry point built from env — no fetch, no
                        knowledge of the wire protocol.
src/repl/hooks.ts    hook discovery: reads `.hooks/<type>/` directories
                        (read-only filesystem access, the only non-tool FS
                        read, invariant 5), returns `HookCommand[]` with
                        `{ name, command, profiles? }` in alphabetical
                        order. Parses an optional `# profiles: a,b,c` first
                        line from each file to set the profile whitelist.
                        No subprocesses, no printing, no fetch.
src/repl/presession.ts runs the configured hook commands: `PRE_SESSION_CMD`
                        once before the first turn, `PRE_TURN_CMD` once before
                        every user turn, and `POST_TURN_CMD` once after the
                        model's final answer. Spawns exactly one subprocess per
                        invocation (the only non-tool spawn, invariant 5),
                        returns the combined stdout+stderr and exit code; no
                        printing of its own — the loop renders the result and
                        appends it to the conversation as a system message
                        (pre hooks always; the post hook only when it exits
                        non-zero).
src/repl/loop.ts      the turn loop: glue between conversation, client,
                        commands, presession, and compact. All I/O (input,
                        rendering, diagnostics) is routed through the swappable
                        Transport seam (src/transport.ts) handed in from the
                        entry point; the loop holds no direct stdin/stdout or
                        render imports. Contains
                        runHook (hook execution + render/append policy),
                        runModelTurn (observer wiring, turn-level hooks, and
                        usage), and maybeAutoCompact (threshold check + apply).
                        The model/tool-call round protocol lives in
                        src/llm/turns.ts and is shared with subagents.
src/repl/compact.ts   conversation compaction: one non-streaming, tool-free
                        chatCompletion call (reasoning_budget_tokens: 0 --
                        summarizing needs no reasoning, regardless of the
                        active /think level) summarizes the whole conversation,
                        then compactConversation returns a fresh, minimal
                        messages array (profile instruction + tools-disabled
                        notice if applicable + the summary) for the caller to
                        install. Deliberately a single rare collapse rather
                        than an incremental trim (see Potential Problems,
                        "Unbounded conversation"). No fetch of its own, no
                        stdin/stdout; loop.ts owns both triggers (the 80%
                        auto-compact check and the /compact command).
src/session.ts        conversation persistence: loadSession() reads
                        .vise/session.json and returns the saved { messages,
                        activeProfile, toolsEnabled, reasoningLevel? } (or
                        null when missing or corrupt; reasoningLevel is
                        undefined for sessions saved before /think existed),
                        refreshing only the generated notes-index
                        prefix on restored system messages; saveSession()
                        writes that same shape to disk, creating .vise/ if
                        needed. Named session
                        snapshots: saveNamedSession() writes the state to
                        .vise/sessions/<name>.json, loadNamedSession() reads
                        it back, deleteNamedSession() removes the file,
                        renameNamedSession() moves it to a new name (refusing
                        to overwrite an existing one), listNamedSessions()
                        lists all saved names, and newConversation() creates a
                        fresh state seeded with the active profile's
                        instruction. A documented non-tool FS reader/writer
                        (invariant 5), like profiles.ts and config/persist.ts,
                        but it touches the disk only at turn boundaries and
                        during /save, /load, /sessions (including its delete
                        and rename subcommands), and /new — never during a
                        tool call. No
                        fetch, no stdin/stdout. loop.ts calls loadSession()
                        before the first turn and saveSession() at the top of
                        every loop iteration; the named-session functions are
                        exposed via CommandContext so the /save, /load,
                        /sessions, and /new handlers in commands.ts can call
                        them.
src/subagent.ts       isolated profile-seeded subagent conversation. Uses
                        src/llm/turns.ts for the same model/tool-round
                        protocol as the main REPL; supplies a dispatch closure
                        and no stream observers so its final text remains a
                        tool result in the parent conversation.
src/tools.ts          tool registry: schema array + dispatch table. Imports
                        handler functions from the tool submodules below and
                        composes them into the `Record<string, handler>` table.
                        No I/O of its own — all filesystem and process work
                        lives in the submodules. Stateless: the ProcessTracker
                        (background subprocess map + ID counter) is passed in
                        as a parameter per invariant 6. No fetch, no
                        stdin/stdout.
src/tools/process.ts  background process tracking: TrackedProcess, spawn,
                        track, and format helpers; the ProcessTracker class;
                        and the run_powershell / wait_for_process /
                        kill_process handlers. The only tool submodule that
                        spawns subprocesses.
src/tools/ask.ts      ask_user schema and handler. The handler awaits the
                        ToolContext.askQuestion callback and has no direct
                        stdin/stdout access; its schema constrains type/options
                        relationships and runtime validation checks model input;
                        subagents omit this tool.
src/tools/fs.ts       file-system handlers: read_file, edit_file, create_file,
                        create_directory, list_directory. The only tool
                        submodule that writes files.
src/tools/search.ts   content-search handlers: find_files, search_content.
                        Owns the shared walkFiles generator, displayPath, and
                        escapeRegex helpers. Read-only filesystem access.
```

Dependency direction: `index -> src/repl/terminalTransport -> src/transport`,
`web.ts -> src/web/server -> src/web/webTransport -> src/transport`, and each
entry point calls `src/repl/loop`; the loop depends on `(src/repl/commands,
src/repl/presession, src/repl/compact, src/session,
src/llm/client, src/llm/turns, src/tools, src/profiles)`. The web server may
import the loop and static web assets, but neither the loop nor the LLM layer
may import a concrete frontend. `src/web/protocol.ts` is a leaf shared-shape
module; browser code is outside the TypeScript module graph and communicates
only through the server's WebSocket frames. The terminal and web frontends
must preserve the same `Transport` behavior, including fresh-line semantics
for `ask_user`.

The broader core dependency direction remains: `index -> src/repl/loop -> (src/repl/input, src/repl/render,
src/repl/commands, src/repl/presession, src/repl/compact, src/session,
src/llm/client, src/llm/turns, src/tools, src/profiles) -> src/llm/models ->
src/llm/types, src/config`. `src/repl/loop.ts` and `src/subagent.ts` use
`src/llm/turns.ts`, which depends only on `src/llm/client.ts`,
`src/llm/types.ts`, and `src/config.ts`. Dependencies point down into the LLM
layer; no `src/llm/*` module imports from the REPL or tools layers.
`src/tools/*` do not import each other; `src/tools.ts` is the only importer of
the tool submodules. `src/config.ts`, `src/config/persist.ts`, `src/llm/types.ts`,
`src/profiles.ts`, `src/session.ts`, and the `src/tools/*` submodules are
leaves. `src/llm/turns.ts` owns no presentation, hooks, or tool access; tool
execution enters only through its dispatch callback.

Commands are the seam that keeps the loop small: `commands.ts` returns a result
value (text to render, or a request to mutate session state) and never prints or
reads input itself. Adding a command must not require editing `loop.ts`; the
registry is the extension point. A command that needs the model (`/context`'s
`getContextSize`, `/compact`'s `compact`) receives a bound closure as a
`CommandContext` field rather than importing the client itself, so
`commands.ts` stays free of `fetch` and of the transport; `/compact`'s closure
returns a full replacement `messages` array via `CommandResult.newMessages`,
which only `loop.ts` (the owner of the conversation) installs. A command may
import a read-only leaf registry directly (for example, the `src/tools`
registry or profile lookup functions). Effects that mutate files must instead
be explicit `CommandContext` capabilities (for example, `createNote` or
`createProfile`), so command handlers do not conceal filesystem writes behind
module imports. Dependencies that reach `fetch` or the transport must also be
passed in via `CommandContext`.

Enforcement: the `bun lint` script (Biome) should check maintained source and
configuration, excluding generated runtime state under `.vise/`; the rest
(function/file/directory line limits — 100/500/10 — is caught by this review and
by the madge-style dependency check below).

Dependency check: `madge --extensions ts src/ index.ts` must show no cycles.
Run it in CI or as part of `bun lint` before it matters.

## Potential Problems

- **Unbounded conversation.** `messages` grows linearly with turns; every request
  re-sends the whole history, so a long session is O(n^2) tokens total and will
  eventually exceed the model's context window (the server returns an error
  rather than truncating). Mitigated by `src/repl/compact.ts`: once usage
  crosses 80% of the server's context window (`GET /props`'s `n_ctx`), or on
  `/compact`, the whole conversation collapses into one summary in a single
  call. Deliberately whole-history-at-once rather than a sliding window that
  trims a few old messages per turn: llama.cpp's KV-cache reuse depends on
  each request sharing a stable prefix with the previous one, so a per-turn
  trim would invalidate the cache every turn, while a rare full collapse
  invalidates it once and then leaves the (now short) prefix stable for many
  turns after. The lookup passes `?model=` because a llama.cpp router reports
  `n_ctx: 0` for its own `/props` and only returns the real window when asked
  about a specific model. Gaps that remain: skipped entirely when the server
  still doesn't report `n_ctx` — such a session can still hit a hard
  context-length error with no warning; a single turn's own tool-call rounds can still grow past the
  window before the turn ends, since compaction only runs between turns;
  and the summarization call's own prompt (existing history plus the summary
  request) must itself fit before the threshold leaves enough headroom for
  the reply — a very large single message pushing past 80% in one turn could
  still fail to compact. Profile switches and hook output continue to append
  system messages between compactions as before; they just no longer
  accumulate forever.
- **Restored sessions refresh note indexes without migrating notes.** The
  note index is embedded in system messages when a conversation is created.
  On restore, `src/session.ts` refreshes only the generated index prefix from
  the current note registry, preserving the rest of the conversation. This is
  path-only: note files remain at `.agents/notes/`, and legacy `.vise/notes/`
  files are neither read nor migrated.
- **Hook command output is unchecked and its latency is unbounded.** Unlike
  tool results (16 KB budget per tracked-process stream, 500-line read cap),
  the pre-session and pre-turn hooks' combined stdout+stderr enter the
  conversation with no budget beyond the shared 16 KB hook cap; their exit
  codes are only printed to stderr, so a failing hook's output still reaches
  the model as context (the post hook deliberately inverts this: it appends
  only on failure, but its appended message carries the raw output with no
  exit-code report, so the model cannot tell the hook failed unless the output
  says so); and they have no timeout, so a hung hook blocks startup
  (pre-session), every user turn (pre-turn), or every final answer (post-turn).
  A hook that fails with no stdout/stderr is also silently dropped — the
  runner returns `null` for empty output, discarding the exit code — so a
  failing check can reach neither the user nor the model. Report a non-zero
  exit code distinctly in the appended message, and give the spawn the same
  timeout/structured-error treatment the client's `fetch` should have.
- **No retry or timeout on `fetch`.** A hung llama.cpp server blocks the REPL
  forever; a transient ECONNREFUSED is reported as a generic error. The client
  should have a `signal`/timeout and a distinguishable "server unreachable"
  error.
- **The reasoning cap is an estimate.** Messages the server hasn't counted
  yet are estimated at 3 characters per token. Because uniform mode stops the
  model from ending its reasoning early, any undercount becomes a context
  overflow mid-thought rather than a harmless early stop. An exact count
  would need `/tokenize` or a clamp inside the llama.cpp fork (which knows the
  real prompt length and per-slot n_ctx). The 1024-token answer reserve may
  also be too small for a large `create_file`/`edit_file` tool-call payload.
- **Forced reasoning is paid per tool round.** Every model round in a turn,
  including each tool-call round, draws its own random length up to the
  (capped) budget, and each round's `reasoning_content` stays in the
  conversation. A tool-heavy turn at a large level therefore costs roughly
  budget/2 x rounds in time and context.
  Future work: a separate, smaller budget for tool-call rounds, and dropping
  `reasoning_content` from earlier rounds.
- **Reasoning length depends on server configuration.** Until `/think <name>`
  selects a level, the client sends no reasoning budget, so a server started
  without `--reasoning-budget` lets the model think without limit, and a
  non-llama.cpp server applies its own policy (and may ignore
  `reasoning_budget_tokens`/`reasoning_budget_uniform` once a level is
  selected, too). The effective behavior is only as good as the server's
  startup flags and the fork it's running; there is no client-side check that
  a budget is in force or that uniform mode is understood.
- **Hard `process.exit(0)` at shutdown.** Any finally-block cleanup or future
  teardown (e.g., flushing a session log) is skipped. Prefer letting the event
  loop drain; keep `process.exit` as a last resort for a stuck loop.
- **Errors are opaque strings.** `Error("HTTP 404: ...")` does not say what
  caused it or what to do. The client should return a structured result
  (`Ok | HttpError | NetworkError`) that answers: what, where, why, fix.
- **Config defaults mask misconfiguration.** `LLM_BASE_URL ?? "http://localhost:8080"`
  silently falls back; a missing `.env.local` produces a confusing network
  error rather than "config missing." Prefer a loud startup check.
- **Config is written back to disk by the REPL.** Persisting the model choice
  makes the process a writer of its own configuration, which is a new failure
  mode: a non-atomic `writeFileSync` can truncate `.env.local` on a crash, a
  value containing spaces or `#` is written unquoted, and a read-only or
  missing directory surfaces as a raw filesystem error. Keep the write in
  `config/persist.ts`, make it atomic (write temp + rename), and treat a failed
  persist as a warning, not a failed switch.
- **Command surface can grow into a god module.** `commands.ts` is the natural
  place for every future `/` feature, and each one tends to want the client, the
  conversation, and the renderer. Keep handlers as pure functions of explicit
  parameters; if a handler needs to print, it returns text instead. Watch for
  `commands.ts` importing `loop.ts` (that would be a cycle).
- **Model switch is not validated against the conversation.** Switching models
  mid-session keeps the history, which is the intended behavior, but a model
  with a smaller context window may reject the accumulated history on the next
  turn — compaction only checks the _current_ model's `n_ctx` after a turn
  completes, so a switch to a much smaller-context model can still overflow
  on the very next request, before compaction gets a chance to run.
- **Catalog fetch is a second network path.** `/model` performs a request that
  is not a chat completion. It must go through the client so timeouts, auth
  headers, and structured errors are shared; a bare `fetch` in the command
  handler would duplicate all three.
- **Tool results are opaque strings.** A tool failure is reported as prose the
  model must parse to decide whether to retry. A structured result
  (`Ok | ToolError`) would say what, where, why, fix. `edit_file` only
  replaces the _first_ occurrence of `replacee`; a model editing a repeated
  string will silently miss later occurrences.
- **Tool-call observers can change dispatch outcomes.** `runTool` invokes the
  start observer before entering its `try` block, and invokes the end observer
  in `finally`; a throwing callback can prevent dispatch or replace a handler's
  result or original error. This contradicts the observational invariant.
  Isolate observer failures so visualization remains best-effort and never
  changes tool execution or its outcome.
- **Background processes outlive the REPL on interrupt.** The EOF path
  reaps tracked processes (`tracker.shutdown()` before `process.exit`),
  but Ctrl-C/SIGINT orphans every running background `powershell`
  subprocess, and finished entries are never pruned from the map, so dead
  process objects can be held for the rest of the session. Reaping must
  cover every exit path (a `process.on("exit")`/`SIGINT` hook in `loop.ts`),
  and the tracker should drop finished entries on access.
- **`list_directory` output is unbounded.** Unlike `read_file` (500-line cap)
  and tool output from tracked processes (16 KB cap), a directory tree has
  no line budget: a `node_modules` at depth ≥ 2 can return thousands of
  lines into the conversation. The walk should filter noise
  (`node_modules`, `.git`) and/or cap the output, the same way the other
  tool results are bounded.
- **`semanticSearch` scans the whole index in memory.** Every call loads
  the entire `chunks` table and runs a JS cosine loop over every row, so
  each search is O(N × dim) in CPU and O(N × dim) in memory. Correct while
  the index is small; at 10k+ chunks it will feel slow and spike memory.
  The fix is an ANN index (or at least a `sqlite-vec`/k-NN vector column)
  in `vectors.ts`, keeping the SQLite DB the storage boundary.
- **Tools in `tools.ts` mix registration with full schemas.** Inline tool
  schemas in `src/tools.ts` make the module exceed 320 lines and tightly couple
  schema definitions with the dispatch table. Submodules (`fs.ts`, `search.ts`,
  `process.ts`) should co-locate their schemas with their handler logic (as
  already prototyped by `run_subagent_schema` in `tools/subagent.ts`), keeping
  `tools.ts` under 50 lines as pure composition.

## Performance

Obvious concerns only; real optimization follows profiling.

- **Conversation re-send is O(n^2) tokens.** Every request re-sends the whole
  history, so a long session costs quadratic tokens total, and the request
  body is re-serialized from scratch each turn. Compaction (Potential
  Problems) bounds the history; the serialization cost is inherent to the
  stateless wire protocol and not worth fighting.
- **Reasoning-token estimate is approximate.** `client.ts` maintains a
  running character count and estimates tokens at roughly four characters per
  token, so each stream delta is O(1) to account for. This is display-only;
  exact usage arrives only at completion and is not split by reasoning vs.
  answer text.
- **`semanticSearch` scans the whole index.** O(N x dim) CPU and memory per
  call over the chunks table (see Potential Problems; the fix is an ANN
  index).
- **Per-reasoning-chunk repaint is bounded.** The thinking indicator repaints
  one line per reasoning chunk; the cost is one \r-repaint per chunk, linear
  in the number of chunks, with no per-chunk allocation beyond the line
  string itself.

- **Token cost:** re-sending full history every turn doubles the tokens per
  added turn; compaction (`src/repl/compact.ts`, see Potential Problems)
  bounds this, at the cost of one extra request each time it runs.
- **Memory:** the line buffer is bounded by input; the conversation is bounded
  only by the model's context window, not by the process. Tracked-process
  output is bounded by `OUTPUT_BUDGET` (16 KB per stream per process, with a
  truncation marker). `read_file` is bounded at 500 lines per call.
  `list_directory` is currently unbounded (see Potential Problems).
- **Command latency:** `/model` with no argument performs a network round-trip
  before printing anything, so it inherits the client's (currently absent)
  timeout. A cached catalog could make listing instant but could go stale; the
  catalog is small, so re-fetching is the right default.

## Future Work

- **Vector ANN index.** Replace `semanticSearch`'s whole-table scan with a
  k-NN index (`sqlite-vec` or an in-memory HNSW over the cached embeddings)
  so search cost stops scaling with the number of indexed chunks. Keep the
  SQLite DB as the durable store; only the scoring path changes.
- **Rename `src/repl/presession.ts` to `src/repl/externalcmd.ts`.** The module
  now runs all three hook commands (`PRE_SESSION_CMD` once before the first
  turn, `PRE_TURN_CMD` before every user turn, `POST_TURN_CMD` after the
  model's final answer), so its name no longer reflects its contents. Rename
  it and its exports (`runPreSessionCmd` -> `runShellCommand`,
  `PreSessionResult` -> `ShellResult`) to the generic hook-command runner.
- **Per-tool co-located modules.** Each tool is a self-contained `ToolModule`
  export from its submodule: a schema (the `Tool` object describing arguments
  to the model) paired with the handler that executes it. `tools.ts` becomes
  pure composition — it imports all `ToolModule` exports and builds the
  `Tool[]` array and dispatch table from them, holding no inline schema
  definitions. Adding a tool then touches exactly one submodule file. Target
  shape:
  ```ts
  export type ToolModule = {
    schema: Tool;
    handler: (
      args: Record<string, unknown>,
      tracker: ProcessTracker,
    ) => Promise<string>;
  };
  ```
  This keeps `tools.ts` under 50 lines and makes the schema the single source
  of truth for what a handler accepts, living next to the code that consumes
  those arguments.
- **Typed tool arguments.** Each `ToolModule` declares a typed argument
  interface (e.g., `ReadFileArgs { path: string; startLine?: number;
endLine?: number }`) rather than `Record<string, unknown>`. The handler
  signature becomes `(args: ReadFileArgs, tracker: ProcessTracker) =>
Promise<string>`, with a thin validation/coercion step at the registry
  boundary that converts the model's JSON into the typed shape. This catches
  argument-name typos at compile time and removes per-handler runtime
  coercion (`String(args.path ?? "")`). The model-facing JSON Schema must
  express the same contract as the TypeScript type rather than leaving
  accepted values implicit: for `ask_user`, constrain `type` to the supported
  question kinds and encode that free-form questions omit `options` while
  choice questions require at least two non-empty strings. Keep the callback
  request a discriminated union so invalid combinations cannot cross the
  transport seam; retain runtime validation at the untrusted model-JSON
  boundary.
- **Structured tool results.** Handlers return a `ToolResult` discriminated
  union (`{ ok: true; text: string } | { ok: false; error: string;
retryable: boolean }`) instead of a bare string. The loop renders the error
  case distinctly and can log non-retryable failures without the model
  guessing from prose.
- **Cancellable reply stream.** `createReplyStream()` now owns the header-once
  and terminator state (the pairing invariant the previous version of this
  item tracked), but it still cannot be cancelled: an interrupted turn
  (Ctrl-C, an error mid-stream) ends the in-flight reply with no `cancel()`
  path, and the EOF/Ctrl-C exit path in `loop.ts` never closes a reply that
  was still streaming. Add a cancel handle (close the stream without the
  full terminator, or with a distinct interruption marker) and call it from
  the interrupt/shutdown path.
- **Subagents are still a silent black box.** The shared `src/llm/turns.ts`
  runner now keeps the main REPL and subagents on the same tool-round
  protocol, including reasoning preservation. `runSubagent` supplies no-op
  stream observers, so nested calls remain invisible until their final tool
  result returns. If users need visibility into long-running nested work,
  add a concise observer/status channel that does not leak subagent token
  output into the parent reply stream.
- **Command registry.** A table of `{ name, description, handler }` so `/help`
  is generated rather than hand-written, unknown commands suggest the nearest
  match, and adding a command is a one-line registration. `/new` (clear the
  conversation) and `/model` are the first entries.
- **Durable in-flight turns.** `src/session.ts` persists the conversation at
  turn boundaries, and `/new` / `/save` / `/load` / `/sessions` give the user
  a way to start fresh and pick among saved sessions, but a crash or Ctrl-C
  _during_ a model turn (after the user message is pushed, before the next
  iteration's save) still loses that turn, and startup resumes the auto-resume
  file unconditionally with no way to list saved sessions from the CLI at
  startup. Add a durable in-flight marker (or save after the user message is
  appended, discarding a dangling user turn on load) and, optionally, a
  startup flag (e.g. `--fresh`) to bypass the auto-resume file.
- **Ctrl-C process reaping.** `tracker.shutdown()` runs before
  `process.exit` on the EOF path but not on a Ctrl-C interrupt; add a
  `process.on("exit")` (or `SIGINT`) hook in `loop.ts` that kills any
  remaining tracked processes.
- **Tests.** Unit tests for `input.ts` (line buffering), `client.ts` (against a
  mocked `fetch`), `loop.ts` (conversation accumulation, including the
  streaming reply path — that the header is printed once on the first delta,
  that a final reply with no tool calls still terminates cleanly, and that an
  empty response renders the `(empty response)` fallback), and each tool
  handler (filesystem fixtures + a stubbed `ProcessTracker`). These are the
  seams that make the module split above safe to execute.
- **Bounded reply budget.** A streamed reply has no size cap: a runaway model
  (or a tool result that echoes a large file into the reply) can write
  unbounded output to the terminal before `renderReplyEnd` runs. The
  conversation-side budget (compaction, above) does not cap the terminal-side
  display. A byte budget on the reply stream — mirroring the
  `OUTPUT_BUDGET` used for tracked-process output — would cap what the user
  sees and what enters the conversation, with a truncation marker when the
  budget is hit.
