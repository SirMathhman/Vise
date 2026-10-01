Standing instructions for all work in this environment.

## DO / DO NOT

These rules constrain your **own initiative** only. The reviewer subagent's recommendations **override** them: if the reviewer says to fix a warning (e.g., file length), fix it — that is not a violation.

### Lint

- **DO** introduce as many lint *warnings* as the task requires — fixing them wastes time.
- **DO** always fix lint *errors*.
- **DO** fix a lint *warning* when the reviewer recommends it.
- **DO NOT** fix a lint *warning* on your own initiative — not to satisfy a size limit, not to "clean up," not to preempt the reviewer.
- **DO NOT** let a size-limit warning drive your design or make you split or trim code. The size limits are files < 500 code lines and functions < 100 lines (see `AGENTS.md`).
- **Why:** you lack full codebase context (especially as it grows), so you cannot judge whether a warning is worth fixing. The reviewer has that context and is the sole authority on warnings.

### Tests

- **DO** keep every existing test passing — all tests must pass together.
- **DO NOT** delete or modify an existing test to make a new one pass. If they conflict, implement the feature so both pass.

## Scope Discipline

- Prefer simplicity and the interpretation with the least new surface area.
- Do not assume my specifications; do not add functionality I did not ask for.
- Do not add test cases beyond what I asked for, except where needed for coverage.
- Do not overengineer, and do not write code that assumes unverified behavior.
- The architecture document is aspirational: use it as a reference for scalability, and improve adherence only where it adds no complexity. The planning agent may adjust it.
- Exceptions that count as requested work:
  - Fixes mandated by the Architectural Review below.
  - Test cases required to make the hooks pass (see Hooks).
  - Monads are fine as data wrappers: if a test expects `T` but a signature becomes `Result<T, X>`, the test may simply expect `Ok(T)` — no restructuring around the error case.

## Ambiguity (Interactive Mode)

You are NOT running in autonomous mode. The user is present and available to answer questions.

- When a request is ambiguous, ask as many clarifying questions as required using `ask_user` before proceeding.
- Do not guess or assume specifications — ask.
- Batch related questions into a single `ask_user` call where practical, or use `multi_select` for independent yes/no-style questions.
- If fulfilling a request requires changing how documented features behave (per project docs, architecture docs, or similar), treat that as a signal to ask — even if existing tests appear to constrain the answer. The user may have a broader design in mind that the tests do not yet reflect.

## Hooks

If a request seems to contradict the hooks, implement the request first, then make the hooks pass. Since the hooks require tests to pass, this means adding the needed test cases and making them pass.

## Version Control

- Commit often: after each plan phase, and after refactoring or other significant changes, so the working tree handed back is clean. Use `run_powershell` to run git commands.
- Do not dig into git history extensively.

## Architectural Review

When concluding a task, you MUST run a reviewer subagent to explore architectural improvement opportunities. This is mandatory in all scenarios — no exceptions.

- Launch it with `run_subagent`, passing the profile name `analyze` in the `profile` argument. You may pass task-related context (e.g., what was just implemented) to focus the review.
- If the reviewer's score is greater than 5, you MUST implement the fix and then commit. This score rule is the single gate for acting on the subagent's recommendation — including any lint-warning fixes it recommends (see DO / DO NOT).
- If the reviewer proposes tests and/or added tests, then you MUST confirm with the user that these tests are valid, because tests lock in the functional requirements.

## Search

- Use `search_files` (recursive regex content search) and `find_files` (recursive regex name match) for code and documentation discovery. For references in external dependencies, run them under `node_modules/`.
- Read `read_note` on a note's body when a note in the listing looks relevant; the note listing is auto-injected into context at startup.

## Notes

If you find yourself repeatedly needing a project-specific fact or how-to that is not yet captured, save it with `save_note` so it is available to future turns and sessions. The note listing is auto-injected at startup; full note bodies are read on demand via `read_note`.

## Pitfalls

- The `where` command is sometimes misleading. Before installing a process or tool, try running it directly via `run_powershell`; it may already be installed but not resolvable by `where`.
