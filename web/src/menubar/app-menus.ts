import type { PanelHandle } from "../status/panel-switch.ts";
import type { PageName } from "../status/panel-switch.ts";
import { theme, type ThemeChoice } from "../status/theme.ts";
import type { MenuEntry, MenuSpec } from "./menubar.ts";
import { relativeTime, type SavedSession } from "../settings/sessions-list.ts";

/** A mode the agent menu switches on and off. */
interface Toggle {
  isOn(): boolean;
  toggle(): void;
}

/** What the menus act on: the parts of the page they open and the lines they send. */
export interface AppMenuContext {
  isBusy(): boolean;
  noFolder(): boolean;
  sidebar: boolean;
  sendLine(text: string): void;
  /** The saved sessions, newest first. */
  sessions(): SavedSession[];
  pages: { open(name: PageName, tab?: string): void };
  pickFolder(): void;
  openNoFolder(): void;
  saveAs(): void;
  files: Toggle;
  terminal: Toggle;
  goal: Toggle;
  burst: Toggle;
  reasoning: HTMLSelectElement;
  tools: PanelHandle;
  git: PanelHandle;
  runWorkflow(): void;
  /** Open the live look at what the model is writing. */
  inspect(): void;
  showShortcuts(): void;
}

/** How many saved sessions the Session menu lists before "All sessions…". */
const RECENT = 8;

const item = (
  label: string,
  run: () => void,
  extra: Partial<Extract<MenuEntry, { kind: "item" }>> = {},
): MenuEntry => ({ kind: "item", label, run, ...extra });

function sessionMenu(ctx: AppMenuContext): MenuEntry[] {
  const busy = ctx.isBusy();
  const saved = ctx.sessions();
  const entries: MenuEntry[] = [
    item("New conversation", () => ctx.sendLine("/new"), { disabled: busy }),
    item("Save as…", ctx.saveAs),
    { kind: "separator" },
    { kind: "heading", label: saved.length > 0 ? "Recent" : "No saved sessions yet" },
  ];
  for (const session of saved.slice(0, RECENT)) {
    const detail = session.updated ? relativeTime(session.updated, new Date()) : undefined;
    entries.push(item(session.name, () => ctx.sendLine(`/resume ${session.id}`), { disabled: busy, detail }));
  }
  entries.push(
    item("All sessions…", () => ctx.pages.open("sessions")),
    { kind: "separator" },
    item("Open folder…", ctx.pickFolder, { detail: "Start a session rooted in a folder" }),
    item("No folder", ctx.openNoFolder, {
      detail: "Just chat: no file or shell tools",
      disabled: ctx.noFolder(),
    }),
  );
  return entries;
}

function viewMenu(ctx: AppMenuContext): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (!ctx.noFolder() && !ctx.sidebar) {
    entries.push(
      item("Files", ctx.files.toggle, { checked: ctx.files.isOn(), shortcut: "Ctrl+B" }),
      item("Terminal", ctx.terminal.toggle, { checked: ctx.terminal.isOn(), shortcut: "Ctrl+`" }),
      { kind: "separator" },
    );
  }
  entries.push({ kind: "heading", label: "Theme" });
  const choices: [ThemeChoice, string][] = [
    ["system", "Match system"],
    ["light", "Light"],
    ["dark", "Dark"],
    ["forest", "Forest"],
    ["volcano", "Volcano"],
    ["underwater", "Underwater"],
  ];
  for (const [value, label] of choices) {
    entries.push(item(label, () => theme.set(value), { checked: theme.choice() === value, radio: true }));
  }
  entries.push(
    { kind: "separator" },
    item("Settings", () => ctx.pages.open("settings"), { shortcut: "Ctrl+," }),
    item("Keyboard shortcuts", ctx.showShortcuts),
  );
  return entries;
}

function agentMenu(ctx: AppMenuContext): MenuEntry[] {
  const busy = ctx.isBusy();
  const entries: MenuEntry[] = [
    item("Tools…", ctx.tools.open, { detail: "Turn tools on or off for this conversation" }),
  ];
  if (!ctx.noFolder() && !ctx.sidebar) entries.push(item("Git…", ctx.git.open));
  entries.push(
    item("Run workflow…", ctx.runWorkflow, { disabled: busy }),
    item("Inspect model output…", ctx.inspect, {
      detail: "See what the model is writing, raw",
    }),
    { kind: "separator" },
    item("Goal checking", ctx.goal.toggle, {
      checked: ctx.goal.isOn(),
      detail: "Keep working until the task is done",
    }),
    item("Burst mode", ctx.burst.toggle, {
      checked: ctx.burst.isOn(),
      disabled: busy,
      detail: "Plan once, then run tools without thinking",
    }),
  );
  const levels = Array.from(ctx.reasoning.options).filter((o) => o.value && !o.disabled);
  if (levels.length > 0) {
    entries.push({ kind: "heading", label: "Reasoning effort" });
    for (const option of levels) {
      entries.push(
        item(option.textContent ?? option.value, () => {
          ctx.reasoning.value = option.value;
          ctx.reasoning.dispatchEvent(new Event("change"));
        }, { checked: ctx.reasoning.value === option.value, radio: true, disabled: busy }),
      );
    }
  }
  entries.push(
    { kind: "separator" },
    item("Compact conversation", () => ctx.sendLine("/compact"), {
      disabled: busy,
      detail: "Summarise older turns to free context",
    }),
    item("Show context usage", () => ctx.sendLine("/context")),
  );
  return entries;
}

/** The menu bar's three menus, in order. */
export function appMenus(ctx: AppMenuContext, triggers: {
  session: HTMLButtonElement;
  view: HTMLButtonElement;
  agent: HTMLButtonElement;
}): MenuSpec[] {
  return [
    { trigger: triggers.session, entries: () => sessionMenu(ctx) },
    { trigger: triggers.view, entries: () => viewMenu(ctx) },
    { trigger: triggers.agent, entries: () => agentMenu(ctx) },
  ];
}
