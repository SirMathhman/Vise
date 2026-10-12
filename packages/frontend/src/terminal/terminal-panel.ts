import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { bindResizeGrip, load, save } from "./grip.ts";
import { theme } from "../status/theme.ts";
import { requiredElement as el } from "../dom.ts";

/** The slice of a server message the terminal reacts to. */
interface TerminalMessage {
  type: string;
  data?: string;
  replay?: boolean;
  code?: number;
  message?: string;
  noFolder?: boolean;
}

const OPEN_KEY = "vise-terminal-open";

function themeFromPage(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string): string => css.getPropertyValue(name).trim();
  return {
    background: v("--bg"),
    foreground: v("--text"),
    cursor: v("--accent"),
    selectionBackground: v("--border"),
  };
}

/** An xterm.js terminal in `view`, refitted (then `onResized`) when the view changes size. */
function createXterm(
  view: HTMLElement,
  onData: (data: string) => void,
  onResized: () => void,
): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
    fontSize: 13,
    scrollback: 5000,
    theme: themeFromPage(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(view);
  // Ctrl+` belongs to the page (it hides the panel), not the shell.
  term.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.key === "`"));
  term.onData(onData);
  let timer: ReturnType<typeof setTimeout> | undefined;
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (view.offsetParent === null) return; // hidden: nothing to measure
      fit.fit();
      onResized();
    }, 80);
  }).observe(view);
  return { term, fit };
}

/**
 * The integrated terminal: the folder's shell, shown with xterm.js in a
 * resizable panel along the bottom of the page. The shell lives on the server
 * (one per folder, kept across reloads), so a page that opens the panel gets
 * the screen so far replayed. Toggled from View → Terminal or with Ctrl+`.
 */
export function createTerminalPanel(
  send: (msg: Record<string, unknown>) => void,
  onError: (text: string) => void,
): {
  toggle(): void;
  isOpen(): boolean;
  handle(message: TerminalMessage): boolean;
} {
  const panel = el<HTMLElement>("terminal");
  const view = el<HTMLElement>("terminal-view");
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let exited = false;

  const visible = (): boolean => !panel.classList.contains("hidden");
  const sendSize = (type: string): void => {
    if (term) send({ type, cols: term.cols, rows: term.rows });
  };

  const ensureTerminal = (): Terminal => {
    if (term) return term;
    const made = createXterm(
      view,
      (data) => {
        if (!exited) {
          send({ type: "term_input", data });
        } else if (data === "\r") {
          exited = false;
          send({ type: "term_restart" });
        }
      },
      () => {
        if (visible()) sendSize("term_resize");
      },
    );
    fit = made.fit;
    term = made.term;
    // The page's colours were copied when the terminal was made; follow a theme change.
    theme.onChange(() => {
      if (term) term.options.theme = themeFromPage();
    });
    return term;
  };

  const open = (): void => {
    const t = ensureTerminal();
    fit?.fit();
    sendSize("term_open");
    t.focus();
  };

  const show = (on: boolean): void => {
    panel.classList.toggle("hidden", !on);
    save(OPEN_KEY, on ? "1" : "0");
    if (on) open();
  };

  bindResizeGrip(panel, el("terminal-grip"), "vise-terminal-height");
  el("terminal-hide").addEventListener("click", () => show(false));
  el("terminal-restart").addEventListener("click", () => {
    exited = false;
    send({ type: "term_restart" });
    term?.focus();
  });
  el("terminal-kill").addEventListener("click", () => send({ type: "term_close" }));
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "`" && !document.body.classList.contains("no-folder")) {
      event.preventDefault();
      show(!visible());
    }
  });

  return {
    toggle: () => show(!visible()),
    isOpen: visible,
    handle(message) {
      switch (message.type) {
        case "term_data": {
          const t = ensureTerminal();
          if (message.replay) {
            t.reset();
            exited = false;
          }
          if (message.data) t.write(message.data);
          return true;
        }
        case "term_exit":
          exited = true;
          term?.write(`\r\n\x1b[2m[process exited ${message.code ?? "?"} — press Enter to restart]\x1b[0m\r\n`);
          return true;
        case "term_error":
          onError(`terminal: ${message.message ?? "error"}`);
          return true;
        case "root":
          // The session is known now: a folder's shell comes back if the panel was open; no folder, no shell.
          if (message.noFolder || document.body.classList.contains("sidebar"))
            panel.classList.add("hidden");
          else if (load(OPEN_KEY) === "1") show(true);
          return false; // the workspace handles it too
        default:
          return false;
      }
    },
  };
}
