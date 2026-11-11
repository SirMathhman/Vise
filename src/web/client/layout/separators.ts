// Movable separators between the three columns: one between the Files tree and the file, one between the file and
// the chat. Dragging a separator, or pressing an arrow key while it has focus, sets the width of the column beside
// it. The widths are kept in this browser's local storage, and are read back when the page loads.

const KEY = "vise.columnWidths";
const STEP = 16;
const MIN_TREE = 180;
const MIN_FILE = 200;
const MIN_CHAT = 300;
const SEPARATOR_WIDTH = 8;

type Which = "tree" | "chat";

interface Widths {
  tree?: number;
  chat?: number;
}

// The two separators, in order: the one after the tree column, and the one after the file column.
export function separators(doc: Document, workspace: HTMLElement): [HTMLElement, HTMLElement] {
  applyWidths(workspace, readWidths());
  return [handle(doc, workspace, "tree"), handle(doc, workspace, "chat")];
}

function handle(doc: Document, workspace: HTMLElement, which: Which): HTMLElement {
  const element = doc.createElement("div");
  element.className = "separator";
  element.setAttribute("role", "separator");
  element.setAttribute("aria-orientation", "vertical");
  element.setAttribute("aria-label", which === "tree" ? "Resize the Files column" : "Resize the chat column");
  element.tabIndex = 0;
  element.addEventListener("pointerdown", (event) => {
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointermove", (event) => {
    if (!element.hasPointerCapture(event.pointerId)) return;
    const rect = workspace.getBoundingClientRect();
    const px = which === "tree" ? event.clientX - rect.left : rect.right - event.clientX;
    setWidth(workspace, which, px);
  });
  element.addEventListener("pointerup", () => writeWidths(workspace));
  element.addEventListener("keydown", (event) => {
    const sign = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (sign === 0) return;
    event.preventDefault();
    const direction = which === "tree" ? sign : -sign;
    setWidth(workspace, which, widthOf(workspace, which) + direction * STEP);
    writeWidths(workspace);
  });
  return element;
}

// Sets one column's width in pixels, kept within its minimum and within the room the other columns leave.
function setWidth(workspace: HTMLElement, which: Which, px: number): void {
  const room = workspace.getBoundingClientRect().width - MIN_FILE - 2 * SEPARATOR_WIDTH;
  const other = widthOf(workspace, which === "tree" ? "chat" : "tree");
  const min = which === "tree" ? MIN_TREE : MIN_CHAT;
  const max = Math.max(min, room - other);
  const clamped = Math.round(Math.min(Math.max(px, min), max));
  workspace.style.setProperty(which === "tree" ? "--tree-col" : "--chat-col", `${clamped}px`);
}

// The width the column has now, in pixels.
function widthOf(workspace: HTMLElement, which: Which): number {
  const column = workspace.querySelector(which === "tree" ? ".tree-column" : ".chat");
  return column?.getBoundingClientRect().width ?? 0;
}

function applyWidths(workspace: HTMLElement, widths: Widths): void {
  if (widths.tree !== undefined) workspace.style.setProperty("--tree-col", `${widths.tree}px`);
  if (widths.chat !== undefined) workspace.style.setProperty("--chat-col", `${widths.chat}px`);
}

function writeWidths(workspace: HTMLElement): void {
  try {
    const widths: Widths = { tree: widthOf(workspace, "tree"), chat: widthOf(workspace, "chat") };
    localStorage.setItem(KEY, JSON.stringify(widths));
  } catch {
    // Storage may be unavailable; the widths then last for this page only.
  }
}

function readWidths(): Widths {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Widths;
    return { tree: finite(parsed.tree), chat: finite(parsed.chat) };
  } catch {
    return {};
  }
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
