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
 * and the two full-width pages, sessions and settings, each of which replaces
 * the chat while it is open. At most one page is open: the ☰ button opens
 * sessions, "settings" opens settings (on the tab last used), the button that
 * opened a page, Escape or "back to chat" closes it.
 */
export function registerHeaderPanels(onOpen: HeaderPanelHooks): void {
  const group = createPanelGroup();
  group.register({
    button: el<HTMLButtonElement>("tools-btn"),
    panel: el("tools-panel"),
  });
  setupTabs(el("settings-page"));
  const pages = [
    { page: el("sessions-page"), button: el<HTMLButtonElement>("sessions-btn"), close: el("sessions-close"), refresh: onOpen.sessions },
    { page: el("settings-page"), button: el<HTMLButtonElement>("settings-btn"), close: el("page-close"), refresh: onOpen.settings },
  ];
  const closeAll = (): void => {
    document.body.classList.remove("page-open");
    for (const { page, button } of pages) {
      page.classList.add("hidden");
      button.setAttribute("aria-expanded", "false");
    }
  };
  for (const { page, button, close, refresh } of pages) {
    button.setAttribute("aria-controls", page.id);
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => {
      const closing = !page.classList.contains("hidden");
      group.closeAll();
      closeAll();
      if (closing) return;
      page.classList.remove("hidden");
      document.body.classList.add("page-open");
      button.setAttribute("aria-expanded", "true");
      refresh();
    });
    close.addEventListener("click", closeAll);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll();
  });
}

/** Page tabs: a tab button (`data-tab` = a page id) shows its page and hides the others. */
function setupTabs(page: HTMLElement): void {
  const tabs = page.querySelectorAll<HTMLButtonElement>(".tab");
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const other of tabs) {
        const on = other === tab;
        other.classList.toggle("active", on);
        other.setAttribute("aria-selected", String(on));
        document
          .getElementById(other.dataset["tab"] ?? "")
          ?.classList.toggle("hidden", !on);
      }
    });
  }
}
