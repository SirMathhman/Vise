import { getSessionRoot } from "../workspace/restore-root.ts";
import { renderScopeContext } from "../settings/scope-context.ts";
import { requiredElement as el } from "../dom.ts";

/** A dropdown: the panel it shows, and the button that toggles it when it has one. */
interface PanelSpec {
  /** A menu-bar trigger or other button; dropdowns opened only from a menu have none. */
  button?: HTMLButtonElement;
  panel: HTMLElement;
  /** Called each time the panel opens (refresh its contents here). */
  onOpen?: () => void;
}

/** One registered dropdown. */
export interface PanelHandle {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

export interface PanelGroup {
  register(spec: PanelSpec): PanelHandle;
  /** Close every registered dropdown. */
  closeAll(): void;
  /** Whether any dropdown is open. */
  anyOpen(): boolean;
}

/**
 * The menus and dropdown panels of the top bar share one spot, so at most one
 * may be open: a later one would otherwise cover an earlier one and hide its
 * controls. Every one registers here instead of toggling its own `hidden`
 * class, so exclusivity, the buttons' `aria-expanded` / `aria-controls`,
 * Escape, and closing on a click elsewhere live in one place and a new panel
 * cannot forget them.
 */
export function createPanelGroup(): PanelGroup {
  const specs: PanelSpec[] = [];
  const isOpen = ({ panel }: PanelSpec): boolean => !panel.classList.contains("hidden");
  const close = ({ button, panel }: PanelSpec): void => {
    panel.classList.add("hidden");
    button?.setAttribute("aria-expanded", "false");
  };
  const open = (spec: PanelSpec): void => {
    specs.forEach(close);
    spec.panel.classList.remove("hidden");
    spec.button?.setAttribute("aria-expanded", "true");
    spec.onOpen?.();
  };
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") specs.forEach(close);
  });
  // A press anywhere outside the open panel (and its button) closes it, as menus do.
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node | null;
    for (const spec of specs) {
      if (!isOpen(spec) || !target) continue;
      if (spec.panel.contains(target) || spec.button?.contains(target)) continue;
      // A dialog opened from the panel (a confirmation) is part of it.
      if ((target as Element).closest?.("dialog")) continue;
      close(spec);
    }
  });
  return {
    closeAll: () => specs.forEach(close),
    anyOpen: () => specs.some(isOpen),
    register(spec) {
      const { button, panel } = spec;
      button?.setAttribute("aria-controls", panel.id);
      button?.setAttribute("aria-expanded", "false");
      specs.push(spec);
      const toggle = (): void => (isOpen(spec) ? close(spec) : open(spec));
      button?.addEventListener("click", toggle);
      return {
        open: () => open(spec),
        close: () => close(spec),
        toggle,
        isOpen: () => isOpen(spec),
      };
    },
  };
}

export type PageName = "sessions" | "settings";

/** What to refresh when each full page opens. */
interface PageHooks {
  settings: () => void;
  sessions: () => void;
}

export interface Pages {
  /** Open a page (settings on `tab` when given, else on the tab last used); opening the open page again closes it. */
  toggle(name: PageName, tab?: string): void;
  open(name: PageName, tab?: string): void;
  close(): void;
  isOpen(name?: PageName): boolean;
}

/**
 * The two full-width pages, sessions and settings, each of which replaces the
 * chat while it is open. At most one is open; the button that opened it (the
 * ⚙ for settings), its ✕, or Escape closes it, and focus goes back to where it
 * was. The menus open them through the returned handle.
 */
export function registerPages(hooks: PageHooks, group: PanelGroup): Pages {
  const tabs = setupTabs(el("settings-page"));
  const pages = {
    sessions: {
      page: el("sessions-page"),
      close: el("sessions-close"),
      refresh: hooks.sessions,
      button: null as HTMLButtonElement | null,
    },
    settings: {
      page: el("settings-page"),
      close: el("page-close"),
      refresh: hooks.settings,
      button: el<HTMLButtonElement>("settings-btn"),
    },
  };
  let returnFocus: HTMLElement | null = null;
  const isOpen = (name?: PageName): boolean =>
    name === undefined
      ? document.body.classList.contains("page-open")
      : !pages[name].page.classList.contains("hidden");
  const close = (): void => {
    if (!isOpen()) return;
    document.body.classList.remove("page-open");
    for (const { page, button } of Object.values(pages)) {
      page.classList.add("hidden");
      button?.setAttribute("aria-expanded", "false");
    }
    returnFocus?.focus();
    returnFocus = null;
  };
  const open = (name: PageName, tab?: string): void => {
    group.closeAll();
    // Switching from the other page keeps the place to return to from before either opened.
    const back = isOpen() ? returnFocus : (document.activeElement as HTMLElement | null);
    returnFocus = null;
    close();
    returnFocus = back;
    const { page, button, refresh } = pages[name];
    page.classList.remove("hidden");
    document.body.classList.add("page-open");
    button?.setAttribute("aria-expanded", "true");
    if (name === "settings") tabs.show(tab);
    refresh();
    page.querySelector<HTMLElement>(".page-title")?.focus();
  };
  for (const [name, { button, close: closer, page }] of Object.entries(pages)) {
    button?.setAttribute("aria-controls", page.id);
    button?.setAttribute("aria-expanded", "false");
    button?.addEventListener("click", () => toggle(name as PageName));
    closer.addEventListener("click", close);
  }
  const toggle = (name: PageName, tab?: string): void =>
    isOpen(name) && tab === undefined ? close() : open(name, tab);
  document.addEventListener("keydown", (event) => {
    // A confirmation on the page closes first.
    if (event.key === "Escape" && !document.querySelector("dialog[open]")) close();
  });
  return { toggle, open, close, isOpen };
}

/** Which tabs are visible when no folder is connected. */
type TabScope = "global" | "project" | "dual";

/** The scope of each settings tab, keyed by its `data-tab` value. */
const TAB_SCOPE: Record<string, TabScope> = {
  "settings-general": "global",
  "settings-profiles": "project",
  "settings-hooks": "project",
  "settings-notes": "dual",
  "settings-workflows": "dual",
  "settings-mcp": "dual",
  "settings-browser": "global",
};

/** The first tab of `tabs` that is not hidden, so a hidden tab is never the one shown. */
export function firstVisibleTab<T extends { hidden: boolean }>(
  tabs: readonly T[],
  wanted?: T,
): T | undefined {
  if (wanted && !wanted.hidden) return wanted;
  return tabs.find((tab) => !tab.hidden);
}

/**
 * The settings page's tabs (a vertical list on wide screens): a tab
 * (`data-tab` = a panel id) shows its panel and hides the others; arrows move
 * between tabs. When no folder is connected, project-only tabs are hidden
 * (their settings have nowhere to live) and the page says so; dual-scope
 * panels get a `no-folder` flag so they show only global content.
 */
function setupTabs(page: HTMLElement): { show(tab?: string): void } {
  const buttons = Array.from(page.querySelectorAll<HTMLButtonElement>(".tab"));
  const noFolder = getSessionRoot() === null;
  renderScopeContext(getSessionRoot(), el("scope-context"));
  const tabs = buttons.map((button) => {
    const id = button.dataset["tab"] ?? "";
    const scope = TAB_SCOPE[id] ?? "global";
    const panel = el(id);
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    button.setAttribute("aria-controls", id);
    if (noFolder && scope === "dual") panel.classList.add("no-folder");
    const hidden = noFolder && scope === "project";
    button.classList.toggle("hidden", hidden);
    return { id, button, panel, hidden };
  });
  let current = firstVisibleTab(tabs);
  const select = (next: (typeof tabs)[number] | undefined, focus = false): void => {
    if (!next) return;
    current = next;
    for (const tab of tabs) {
      const on = tab === next;
      tab.button.classList.toggle("active", on);
      tab.button.setAttribute("aria-selected", String(on));
      tab.button.tabIndex = on ? 0 : -1;
      tab.panel.classList.toggle("hidden", !on);
    }
    if (focus) next.button.focus();
  };
  for (const tab of tabs) {
    tab.button.addEventListener("click", () => select(tab));
    tab.button.addEventListener("keydown", (event) => {
      const visible = tabs.filter((t) => !t.hidden);
      const at = visible.indexOf(tab);
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      if (step !== undefined) {
        event.preventDefault();
        select(visible[(at + step + visible.length) % visible.length], true);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        select(event.key === "Home" ? visible[0] : visible.at(-1), true);
      }
    });
  }
  select(current);
  return {
    show(id) {
      const wanted = tabs.find((tab) => tab.id === `settings-${id ?? ""}`);
      select(firstVisibleTab(tabs, wanted ?? current));
    },
  };
}

/** Whether no folder is connected (for the settings panels that need to adjust). */
export function isNoFolder(): boolean {
  return getSessionRoot() === null;
}
