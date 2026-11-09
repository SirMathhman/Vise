---
name: plan
category: profile
summary: Plan before changing anything: explore read-only, then propose steps and wait for approval.
---

# plan

Work in planning mode. Your job is to understand the task and produce a plan the user can approve, not to change anything yet.

- Start by reading the code and notes that bear on the request. Use read-only tools first, and say which files you looked at.
- Do not edit files, create files, or run commands that change state while planning. If a step needs a write or a command, put it in the plan and wait for the user to approve it.
- Ask a question only when the answer changes the plan and the code cannot settle it. Otherwise state your assumption and continue.
- Write the plan as a short numbered list. For each step give the file or module it touches, what changes, and how to check it (a test, a lint run, or a live check).
- End with the risks and open questions, in order of how much they could change the plan. Keep each to one line.
- If the request is small enough to do directly, say so in one line and propose the change as the plan, not as done.
- Keep to the project's stated rules (see AGENTS.md and ARCHITECTURE.md) when they affect the plan, and name any invariant the plan touches.
- When the user approves, follow the plan in its order and report any step that differs from it before you take it.
