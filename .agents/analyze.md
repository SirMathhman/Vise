# Profile: analyze

# Procedure

1. Perform a holistic, bird's-eye review of the entire architecture. Do not focus on a single area in isolation. The body of knowledge below lists common code smells to watch for, but the review is not limited to that list.
2. From the findings, select exactly one improvement, guided by the principle of least surprise.
3. Update the canonical architecture document whenever any of the triggers in the "When to Update the Architecture Document" section applies.

# When to Update the Architecture Document

Update the document whenever any of the following is true:

- The review reveals a discrepancy between the document and the ideal architecture.
- The code has caught up to the document: when the code implements what the document pointed toward, the document must advance further. The document must never be structurally out of date.
- A new module or layer has been introduced (a new top-level module, a new dependency direction) that the document does not yet describe.
- A fix recommended by a review has been implemented and has changed the architecture.

The document should sit quite a bit ahead of the code, not merely slightly ahead.

# Constraints

- Do not edit any files other than the canonical architecture document. Creating the document (when it does not yet exist) is permitted.
- Recommend exactly one improvement: do not omit it, and do not provide more than one. If the architecture is sound, still identify the single highest-value improvement.
- The body of knowledge informs the selection of the single improvement; it does not require one recommendation per item.

# Deliverables

1) One improvement, no matter how big or small:
   - It must be actionable.
   - Assign it a score from 1 (nice to have) to 10 (critical for maintainability).
   - Optionally, include a plan if the fix is straightforward.
   - When multiple candidates exist, prefer them in roughly this order. Recursion issues rank first because they constrain how the codebase can be split; the goal of the remaining categories is to ensure that good architectures build strong foundations early, while projects are still small:
     - Recursion (including mutual recursion) that blocks splitting the codebase into files without circular imports
     - Linting errors
     - Adherence to the architecture document
     - Codebase size constraints
     - Anything else

2) The canonical architecture document, kept slightly ahead of the code:
   - A single document describing the ideal, industry-standard architecture for this project — a reference to keep in mind as the project scales.
   - It should describe what the architecture should be, not what it currently is. It should sit quite a bit ahead of the current design: focused on scalability and the ideal architecture the project is working toward. If the document merely mirrors the present design, it is not doing its job — it must always point much further.
   - It should describe an architecture that would be familiar to other developers working on this project.
   - Recommended layout, at minimum: 
     - Definitions (core terms and invariants)
     - Structure (module/crate layout and dependency direction),
     - Potential Problems (known risks, limits, and failure modes to watch)
     - Future Work (what the architecture is working toward)
     - Performance (where things might take a while). Note that this section should just have obvious concerns, real performance optimization will be done using a profiler, ideally.
   - The document is not a changelog: completed work is not recorded in it. Progress is visible in the git log (or a separate document); the document only describes the ideal architecture and the work that remains.
   - If the document does not exist, create it.
   - Edit it only when the review reveals a discrepancy; unnecessary edits add noise.

# Body of Knowledge

## Naming

Ensure that naming conventions are consistent. This applies not only to identifiers in source code, but also to file names. When a file's name does not reflect its contents, suggest renaming it so that its contents are not surprising.

## Modularity

Prefer keeping functions, files, and directories small, within these hard limits:
- Max 100 lines per function.
- Max 500 lines per file (count only code lines — ignore blank lines and comments where the tooling allows).
- Max 10 files per directory.

Prefer enforcing these limits through a linter (function line/complexity rules, a file-size rule, and a directory-size rule) so violations are caught automatically rather than by eye. Where a linter cannot express a limit, flag it for manual review. If a function, file, or directory exceeds its limit, strongly recommend splitting it into separate parts.

The project may define a reviewer-specific lint command (a separate lint script or config beyond the standard one) that surfaces additional warnings relevant to architectural review. Check the project's package manifest or task runner for such a command and run it as part of the review.

Do not suggest fixes that rely on whitespace; the linter may be configured to ignore it. Instead, propose a proper splitting plan.

Be careful with recursion. It is acceptable in small systems, but in large, complex ones, consider a non-recursive solution. The reason: when the system is split into smaller files, recursive structure tends to produce circular dependencies between those files, which makes isolation and testing harder.

Mutual recursion is not allowed once it grows too much. Mutually recursive functions are quite hard to separate into files if circular imports between files are not allowed. The simple solution: pass the other function as a parameter. For a given `fn a() => b(); fn b() => a();`, do `fn a() => b(a); fn b(a : () => Void) => a();`.

You can and should consider large refactors when extensive tests are present, because the tests give confidence to make sweeping changes.

## Errors

Avoid exceptions, whether checked or unchecked. Prefer a Result monad instead, because it makes control flow easier to follow. If you see code throwing an exception, flag it for conversion to a Result before the pattern spreads.

Errors must not be misleading. Prefer structured errors over plain string messages, ideally an error enum.

To be actionable, an error should answer these four questions:
- What is this error?
- Where can I find the thing that caused the error?
- Why is this an error?
- What can I do to make this error go away?



