import type { ToolSwitch } from "../../../protocol/protocol.ts";
import { panelBox } from "../mcp-view.ts";

// The Tools panel: the tools grouped by their source (a server's name for an MCP tool, "built-in tools" for the rest).
// Each group folds, shows how many of its tools are on, and has a button that turns all of them on or off. A filter
// shows only the tools whose names match, and keeps its text when the list changes. A click sends /tools enable or
// disable, the line the user would type, and a change applies from the next request.

export interface ToolsActions {
  line(text: string): void;
}

export interface ToolsSection {
  section: HTMLElement;
  update(tools: ToolSwitch[], sendable: boolean): void;
}

// A group with more tools than this starts closed, unless the filter is in use.
const OPEN_LIMIT = 8;

// "built-in tools" has a space, which a server name cannot have, so it never clashes with a server.
const BUILT_IN = "built-in tools";

export interface ToolGroup {
  name: string;
  tools: ToolSwitch[];
}

// What a group shows: the filter text (lower case), whether the page may send, and the actions.
interface GroupView {
  text: string;
  sendable: boolean;
  actions: ToolsActions;
}

export function createToolsSection(doc: Document, actions: ToolsActions): ToolsSection {
  const box = panelBox(doc);
  const filter = doc.createElement("input");
  filter.type = "search";
  filter.placeholder = "filter tools";
  const groups = doc.createElement("div");
  groups.className = "tools-groups";
  let tools: ToolSwitch[] = [];
  let sendable = false;
  let key = "";
  const render = (): void => {
    const text = filter.value.trim().toLowerCase();
    const nodes = groupsOf(tools)
      .map((group) => groupNode(doc, group, { text, sendable, actions }))
      .filter((node): node is HTMLElement => node !== undefined);
    groups.replaceChildren(...nodes);
  };
  filter.addEventListener("input", render);
  return {
    section: box.element,
    update(next, canSend) {
      const nextKey = JSON.stringify([next, canSend]);
      if (nextKey === key) return;
      key = nextKey;
      tools = next;
      sendable = canSend;
      const on = tools.filter((tool) => tool.enabled).length;
      box.show("Tools", tools.length, [hint(doc, `a change applies from the next request; ${on} of ${tools.length} on`), filter, groups]);
      render();
    },
  };
}

// The source of a tool: the part of an MCP tool's name before "__", or the built-in group.
export function sourceOf(name: string): string {
  const at = name.indexOf("__");
  return at === -1 ? BUILT_IN : name.slice(0, at);
}

// The tools of each source, in the order their first tool appears.
export function groupsOf(tools: ToolSwitch[]): ToolGroup[] {
  const bySource = new Map<string, ToolSwitch[]>();
  for (const tool of tools) {
    const source = sourceOf(tool.name);
    bySource.set(source, [...(bySource.get(source) ?? []), tool]);
  }
  return [...bySource].map(([name, list]) => ({ name, tools: list }));
}

// One group, or nothing when the filter matches none of its tools. Its button turns every tool in the group to the
// other state; the filter only decides which tools are listed.
function groupNode(doc: Document, group: ToolGroup, view: GroupView): HTMLElement | undefined {
  const { text, sendable, actions } = view;
  const shown = group.tools.filter((tool) => tool.name.toLowerCase().includes(text));
  if (shown.length === 0) return undefined;
  const on = group.tools.filter((tool) => tool.enabled).length;
  const turnOn = on < group.tools.length;
  const details = doc.createElement("details");
  details.className = "tool-group";
  details.open = text !== "" || group.tools.length <= OPEN_LIMIT;
  const summary = doc.createElement("summary");
  summary.textContent = `${group.name} (${on} of ${group.tools.length} on)`;
  const bulk = doc.createElement("button");
  bulk.type = "button";
  bulk.className = "tool";
  bulk.textContent = turnOn ? "turn all on" : "turn all off";
  bulk.disabled = !sendable;
  bulk.addEventListener("click", () => {
    for (const tool of group.tools) {
      if (tool.enabled !== turnOn) actions.line(`/tools ${turnOn ? "enable" : "disable"} ${tool.name}`);
    }
  });
  const body = doc.createElement("div");
  body.append(bulk, ...shown.map((tool) => toolButton(doc, tool, view)));
  details.append(summary, body);
  return details;
}

function toolButton(doc: Document, tool: ToolSwitch, view: GroupView): HTMLElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "tool";
  button.textContent = `${tool.name}: ${tool.enabled ? "on" : "off"}`;
  button.disabled = !view.sendable;
  button.setAttribute("aria-pressed", String(tool.enabled));
  const action = tool.enabled ? "disable" : "enable";
  button.addEventListener("click", () => view.actions.line(`/tools ${action} ${tool.name}`));
  return button;
}

function hint(doc: Document, text: string): HTMLElement {
  const span = doc.createElement("span");
  span.className = "hint";
  span.textContent = text;
  return span;
}
