/** A header dropdown panel: the button that toggles it and the panel it shows. */
interface PanelSpec {
  button: HTMLButtonElement;
  panel: HTMLElement;
  /** Called each time the panel opens (refresh its contents here). */
  onOpen?: () => void;
}

export interface PanelGroup {
  register(spec: PanelSpec): void;
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

/** What to refresh when each header panel opens (the tools panel needs nothing). */
interface HeaderPanelHooks {
  profiles: () => void;
  hooks: () => void;
  sessions: () => void;
}

/** Register the header dropdown panels (tools, profiles, hooks, sessions) in one group. */
export function registerHeaderPanels(onOpen: HeaderPanelHooks): void {
  const group = createPanelGroup();
  const el = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing required element #${id}`);
    return found as T;
  };
  const panels: [string, (() => void) | undefined][] = [
    ["tools", undefined],
    ["profiles", onOpen.profiles],
    ["hooks", onOpen.hooks],
    ["sessions", onOpen.sessions],
  ];
  for (const [name, open] of panels) {
    group.register({
      button: el<HTMLButtonElement>(`${name}-btn`),
      panel: el(`${name}-panel`),
      onOpen: open,
    });
  }
}
