import { formatSemanticStatus } from "../../../../src/output/semantic-format.ts";
import type { SemanticHit, SemanticStatus } from "../../../../src/repl/ports.ts";
import { make, requiredElement as el } from "../../dom.ts";

/** The fields of a `sem_*` message the search box reads (see `src/web/api/semantic/semantic-api.ts`). */
export interface SemanticSearchMessage {
  type: string;
  status?: SemanticStatus | null;
  hits?: SemanticHit[];
  query?: string;
  error?: string;
}

/** The parts of the page the search box drives. */
export interface SemanticSearchUi {
  form: HTMLFormElement;
  input: HTMLInputElement;
  /** One line under the box: what the index holds, or why it cannot be used. */
  status: HTMLElement;
  /** Replaces the file tree while a query is shown. */
  results: HTMLUListElement;
  /** What the results replace (the tree's path line and list). */
  tree: HTMLElement[];
  send(message: Record<string, unknown>): void;
  /** Open a file and show its line `line` (1-based). */
  open(path: string, line: number): void;
}

/** How long typing must pause before a query is sent. */
const DEBOUNCE_MS = 300;

/** `src/a.ts:12-40`: where a hit is. */
export function hitLocation(hit: SemanticHit): string {
  return `${hit.path}:${hit.startLine}-${hit.endLine}`;
}

/** The status line for the box, with the rebuild hint when the index was built by another model. */
export function statusText(status: SemanticStatus): string {
  return formatSemanticStatus(status);
}

/** One hit as a row: where it is, how close it is, and the start of the passage; activating it opens the file there. */
function hitRow(hit: SemanticHit, open: (path: string, line: number) => void): HTMLLIElement {
  const item = make("li", "sem-hit");
  const button = make("button", "sem-hit-open");
  button.type = "button";
  button.title = `Open ${hitLocation(hit)}`;
  const head = make("span", "sem-hit-head");
  head.append(make("span", "sem-hit-path", hitLocation(hit)), make("span", "badge badge--sm", hit.score.toFixed(2)));
  button.append(head, make("pre", "sem-hit-snippet", hit.snippet));
  button.addEventListener("click", () => open(hit.path, hit.startLine));
  item.append(button);
  return item;
}

/**
 * The explorer's "search by meaning" box. Shown only when the server has a
 * semantic index for the folder; a query replaces the tree with ranked
 * passages, clearing it brings the tree back. Replies are matched to the
 * query that is still in the box, so a slow answer never overwrites a newer one.
 */
export function createSemanticSearch(ui: SemanticSearchUi): { handle(message: SemanticSearchMessage): boolean } {
  let latest = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const showTree = (): void => {
    ui.results.classList.add("hidden");
    for (const part of ui.tree) part.classList.remove("hidden");
  };
  const showResults = (): void => {
    for (const part of ui.tree) part.classList.add("hidden");
    ui.results.classList.remove("hidden");
  };
  const note = (text: string): void => {
    ui.results.textContent = "";
    ui.results.append(make("li", "list-empty", text));
  };

  const search = (): void => {
    latest = ui.input.value.trim();
    if (latest === "") {
      showTree();
      return;
    }
    showResults();
    note("Searching…");
    ui.send({ type: "sem_search", query: latest });
  };

  ui.form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(timer);
    search();
  });
  ui.input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, DEBOUNCE_MS);
  });

  const showStatus = (status: SemanticStatus): void => {
    ui.status.textContent = statusText(status);
    ui.status.classList.toggle("sem-status-bad", status.state === "unavailable");
    ui.status.classList.remove("hidden");
  };

  return {
    handle(message) {
      if (message.type === "sem_status") {
        // No status: this session has no folder to index, so there is no box.
        ui.form.classList.toggle("hidden", !message.status);
        if (!message.status) {
          ui.status.classList.add("hidden");
          showTree();
          return true;
        }
        showStatus(message.status);
        return true;
      }
      if (message.type !== "sem_results") return false;
      if (message.status) showStatus(message.status);
      if (message.query !== latest) return true; // an answer to something no longer in the box
      if (message.error) note(message.error);
      else if (!message.hits || message.hits.length === 0) {
        note(message.status && message.status.state !== "ready" ? statusText(message.status) : `Nothing close to "${latest}".`);
      } else {
        ui.results.textContent = "";
        for (const hit of message.hits) ui.results.append(hitRow(hit, ui.open));
      }
      return true;
    },
  };
}

/**
 * The box wired to index.html: its elements, and opening a hit by loading the
 * file (through `openFile`) and scrolling its text to the hit's first line.
 */
export function mountSemanticSearch(
  send: (message: Record<string, unknown>) => void,
  openFile: (path: string) => Promise<void>,
): { handle(message: SemanticSearchMessage): boolean } {
  const viewer = el<HTMLPreElement>("files-viewer");
  const openAt = async (path: string, line: number): Promise<void> => {
    await openFile(path);
    const lineHeight = parseFloat(getComputedStyle(viewer).lineHeight);
    const px = Number.isFinite(lineHeight) ? lineHeight : parseFloat(getComputedStyle(viewer).fontSize) * 1.4;
    viewer.scrollTop = Math.max(0, (line - 1) * px);
  };
  return createSemanticSearch({
    form: el<HTMLFormElement>("sem-form"),
    input: el<HTMLInputElement>("sem-input"),
    status: el<HTMLElement>("sem-status"),
    results: el<HTMLUListElement>("sem-results"),
    tree: [el<HTMLElement>("files-path"), el<HTMLElement>("files-list")],
    send,
    open: (path, line) => void openAt(path, line),
  });
}
