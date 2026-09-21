# Profile: analyze

# Procedure

1. Perform a holistic, bird's-eye review of the entire architecture. Do not focus on a single area in isolation. The body of knowledge below lists common code smells to watch for, but the review is not limited to that list.
2. If the project has a frontend, perform a **UI and ergonomics review** using the browser tools (see "UI and Ergonomics" in the Body of Knowledge). This is a first-class part of the review, not an afterthought.
3. From the findings, select exactly one improvement, guided by the principle of least surprise.
4. Update the canonical architecture document whenever any of the triggers in the "When to Update the Architecture Document" section applies.

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

## UI and Ergonomics

When the project has a frontend, the review must include a hands-on UI inspection using the browser tools. A static code review alone will miss layout, spacing, contrast, and interaction problems that only become visible in a rendered page.

### How to inspect

1. **Open the page** with `open_browser_page` (or reuse an already-open page). If the dev server is not running, start it first.
2. **Read the page** with `read_page` to get an accessibility snapshot of the full DOM tree. This gives you the structure, text content, and element hierarchy.
3. **Screenshot the full page** with `screenshot_page` to catch visual issues (overlapping elements, misalignment, color contrast, spacing) that the accessibility tree does not reveal.
4. **Inspect individual elements** — this is critical. Do not stop at the whole-page view. For each interactive or visually distinct element (buttons, inputs, links, cards, modals, navigation items, etc.):
   - Use `screenshot_page` with a `ref` or `selector` to capture that specific element in isolation.
   - Use `hover_element` to reveal hover states, tooltips, and focus rings.
   - Use `click_element` to trigger state changes (dropdowns, tabs, modals) and then re-read or re-screenshot to see the result.
   - Use `type_in_page` to test form inputs: check placeholder text, validation messages, and how the element responds to content of varying length.
   - Use `run_playwright_code` for targeted checks (e.g., reading computed styles, measuring element dimensions, checking `aria-*` attributes, verifying focus order).
5. **Test interactions end-to-end**: navigate between views, submit forms, toggle states. Observe what the user actually experiences, not just what the code intends.

### What to look for

- **Layout & spacing**: overlapping elements, inconsistent margins/padding, content overflowing its container, misaligned columns or rows.
- **Nested scrollbars**: a scrollable container inside another scrollable container (e.g. a panel with its own `overflow: auto` sitting inside a scrollable page or another scrollable panel). Nested scrollbars are confusing and hard to use — never allow them. When content in an inner region can grow unbounded, that region needs to be its own single scroll context, not stacked inside a second one.
  - **Alternative designs to suggest when nested scrollbars are present:**
    - **Move the scroll to a single outer container**: make only one of the two regions scrollable and let the other grow naturally (or be sized to fit). The inner region should not have `overflow: auto/scroll` if an outer region is already scrolling.
    - **Use a modal or overlay**: if the inner region's content is unbounded (e.g. a long editor or log), present it in a modal/overlay with its own scroll context that is not nested inside the page's scroll — the modal becomes the sole scroll container for that content.
    - **Virtualize long lists**: if the inner region is a list that can grow very large, use virtualization (only render visible items) so the list's natural height stays bounded and no inner scrollbar is needed.
    - **Split into separate panels/tabs**: if two regions both need to be independently scrollable, separate them into sibling panels or tabs rather than nesting one inside the other.
- **Typography & readability**: font sizes that are too small, poor line-height, text truncation without a tooltip, low contrast between text and background.
- **Interactive states**: missing or inconsistent hover/focus/active/disabled states, focus not visible (keyboard accessibility), no visual feedback on click.
- **Forms & inputs**: missing labels, unclear placeholder vs. label, no validation feedback, inputs too small to tap/click comfortably.
- **Navigation & wayfinding**: unclear current location, no breadcrumb or back affordance, navigation items that do not indicate their state (active/inactive).
- **Responsive behavior**: if feasible, resize the viewport (via `run_playwright_code`) and check that the layout does not break at narrower widths.
- **Ergonomics & flow**: does the page require scrolling to reach primary actions? Are related controls grouped logically? Does the user have to guess what an icon or button does?
- **Consistency**: do similar elements look and behave the same way across the page? Are spacing, colors, and border-radius values consistent?
- **Empty & error states**: what does the user see when there is no data, when a request fails, or when a form is invalid?

### Examples of issues to catch

These are the kinds of problems that only surface when you measure and interact with individual elements, not when you glance at the whole page:

- **Horizontal overflow inside a fixed-width panel**: a container with a set width (e.g. a sidebar or tree panel) whose content is wider than the container (`scrollWidth` > `clientWidth`). The user sees clipped text or a scrollbar that was not intended. Check every panel, list, and card, not just the page.
- **A content region that is far taller than its viewport**: an element whose natural height is many times the visible height (e.g. a code or log viewer that is thousands of pixels tall inside a ~300px scroll box). The user must scroll a long way to reach the end; consider pagination, virtualization, or a "jump to end" affordance.
- **Small interactive targets**: buttons, toggles, or expand/collapse controls that are only ~20px wide or ~26px tall. These are hard to click, especially for touch or imprecise mouse use. Flag anything below a comfortable minimum (roughly 24×24px, ideally 32×32px or larger).
- **Narrow input fields**: text inputs or search boxes that are short in height or width relative to their content, or that truncate long input without a visible affordance.
- **Text truncation without a tooltip**: labels or file names that are cut off with no way for the user to see the full value on hover.
- **Inconsistent indentation or alignment in nested structures**: tree items or list rows where child elements are not clearly indented relative to their parent, making hierarchy hard to read.
- **Missing visual state on interactive elements**: a clickable row or item that gives no hover, focus, or selected indication, so the user cannot tell what is active.

### Reporting

When a UI issue is found, describe it concretely: which element, what is wrong, and what the user experiences. A screenshot reference (the element or region) makes the finding actionable. UI issues are valid candidates for the single improvement recommendation, scored on the same 1–10 scale as code-level issues.