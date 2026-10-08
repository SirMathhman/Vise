/** A header dropdown panel: the button that toggles it and the panel it shows. */
interface PanelSpec {
  button: HTMLButtonElement;
  panel: HTMLElement;
  /** Called each time the panel opens (refresh its contents here). */
  onOpen?: () => void;
}

export interface PanelGroup {
  register(spec: PanelSpec): void;
  /** Close every registered dropdown. */
  closeAll(): void;
}

/**
 * The header dropdown panels share one spot, so at most one may be open: a
 * later panel would otherwise cover an earlier one and hide its controls.
 * Every panel registers here instead of toggling its own `hidden` class, so
 * exclusivity, the buttons' `aria-expanded` / `aria-controls`, and
 * Escape-to-close live in one place and a new panel cannot forget them.
 */
export function createPanelGroup(): PanelGroup {
  const specs: PanelSpec[] = [];
  const close = ({ button, panel }: PanelSpec): void => {
    panel.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
  };
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") specs.forEach(close);
  });
  return {
    closeAll: () => specs.forEach(close),
    register(spec) {
      const { button, panel, onOpen } = spec;
      button.setAttribute("aria-controls", panel.id);
      button.setAttribute("aria-expanded", "false");
      specs.push(spec);
      button.addEventListener("click", () => {
        const opening = panel.classList.contains("hidden");
        specs.forEach(close);
        if (!opening) return;
        panel.classList.remove("hidden");
        button.setAttribute("aria-expanded", "true");
        onOpen?.();
      });
    },
  };
}

/** What to refresh when the sessions and settings page opens from each of its buttons. */
interface HeaderPanelHooks {
  settings: () => void;
  sessions: () => void;
}

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing required element #${id}`);
  return found as T;
};

/**
 * Register the header's one dropdown (tools, which has to stay quick to toggle)
 * and the sessions-and-settings page: a full-width view that replaces the chat
 * while it is open. The ☰ button opens it on the sessions tab and "settings" on
 * the last settings tab; the same button, Escape or "back to chat" close it.
 */
export function registerHeaderPanels(onOpen: HeaderPanelHooks): void {
  const group = createPanelGroup();
  group.register({
    button: el<HTMLButtonElement>("tools-btn"),
    panel: el("tools-panel"),
  });
  const page = el("page");
  const select = setupTabs(page);
  const openers: [HTMLButtonElement, string, () => void][] = [
    [el("sessions-btn"), "settings-sessions", onOpen.sessions],
    [el("settings-btn"), "settings-profiles", onOpen.settings],
  ];
  let lastSettingsTab = "settings-profiles";
  let openedBy: HTMLButtonElement | undefined;
  const close = (): void => {
    page.classList.add("hidden");
    document.body.classList.remove("page-open");
    openedBy = undefined;
    for (const [button] of openers) button.setAttribute("aria-expanded", "false");
  };
  for (const [button, tab, refresh] of openers) {
    button.setAttribute("aria-controls", "page");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => {
      // The button that opened the page closes it again.
      const closing = openedBy === button;
      group.closeAll();
      close();
      if (closing) return;
      openedBy = button;
      page.classList.remove("hidden");
      document.body.classList.add("page-open");
      button.setAttribute("aria-expanded", "true");
      select(tab === "settings-profiles" ? lastSettingsTab : tab);
      refresh();
    });
  }
  page.addEventListener("click", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>(".tab");
    const name = tab?.dataset["tab"];
    if (name && name !== "settings-sessions") lastSettingsTab = name;
  });
  el("page-close").addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

/** Page tabs: a tab button (`data-tab` = a page id) shows its page and hides the others. Returns a function that selects a tab by id. */
function setupTabs(page: HTMLElement): (id: string) => void {
  const tabs = page.querySelectorAll<HTMLButtonElement>(".tab");
  const select = (id: string): void => {
    page.dataset["tab"] = id;
    for (const other of tabs) {
      const on = other.dataset["tab"] === id;
      other.classList.toggle("active", on);
      other.setAttribute("aria-selected", String(on));
      document
        .getElementById(other.dataset["tab"] ?? "")
        ?.classList.toggle("hidden", !on);
    }
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab.dataset["tab"] ?? ""));
  }
  return select;
}
