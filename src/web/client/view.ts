import type {
  ApprovalAnswer,
  ProfileDetail,
  ProfileSummary,
  ToolSwitch,
} from "../../protocol/protocol.ts";
import {
  canSend,
  openApproval,
  type ApprovalBlock,
  type Block,
  type ViewState,
} from "./state.ts";

// What the view asks the page to do. The page sends the line or the answer to the server.
export interface ViewActions {
  line(text: string): void;
  answer(id: number, answer: ApprovalAnswer): void;
  readProfile(name: string): void;
  writeProfile(profile: ProfileDetail): void;
}

export interface View {
  render(state: ViewState): void;
}

const LINK_TEXT: Record<ViewState["link"], string> = {
  connecting: "connecting",
  live: "connected",
  lost: "disconnected, retrying",
  taken: "this session was opened in another tab",
  "no-token": "open the link printed in the terminal",
};

// Every piece of text is set with textContent, never as HTML, so model output cannot run as markup.
function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function approvalCard(
  doc: Document,
  block: ApprovalBlock,
  actions: ViewActions,
): HTMLElement {
  const card = element(doc, "section", "block approval", "");
  card.append(element(doc, "p", "label", "Approve this change?"));
  card.append(element(doc, "pre", "preview", block.preview));
  if (block.answer !== undefined) {
    card.append(element(doc, "p", "answered", `answered: ${block.answer}`));
    return card;
  }
  const buttons = doc.createElement("div");
  buttons.className = "buttons";
  const choices: [string, ApprovalAnswer][] = [
    ["Approve", "approve"],
    ["Refuse", "refuse"],
    ["End session", "exit"],
  ];
  for (const [label, answer] of choices) {
    const button = element(doc, "button", "choice", label);
    button.dataset.answer = answer;
    button.addEventListener("click", () => actions.answer(block.id, answer));
    buttons.append(button);
  }
  card.append(buttons);
  return card;
}

function blockElement(
  doc: Document,
  block: Block,
  actions: ViewActions,
): HTMLElement {
  switch (block.kind) {
    case "user":
      return element(doc, "div", "block user", block.text);
    case "reply":
      return element(doc, "div", "block reply", block.text);
    case "thinking": {
      const label = block.exact
        ? `thinking: ${block.tokens} tokens`
        : `thinking: ~${block.tokens} tokens`;
      return element(doc, "div", "block thinking", label);
    }
    case "tool":
      return element(
        doc,
        "div",
        block.skipped ? "block tool skipped" : "block tool",
        block.skipped
          ? `${block.description} did not run: the session ended`
          : block.description,
      );
    case "approval":
      return approvalCard(doc, block, actions);
    case "hook": {
      const details = doc.createElement("details");
      details.className = "block hook";
      details.append(element(doc, "summary", "", "hook output"));
      details.append(element(doc, "pre", "", block.text));
      return details;
    }
    case "notice":
      return element(doc, "div", "block notice", block.text);
    case "error":
      return element(doc, "div", "block error", `error: ${block.message}`);
  }
}

// The saved sessions, each a button that loads it. Clicking sends /load <name>, the line the user would
// type, so the page keeps to lines and approvals.
function sessionsPanel(
  doc: Document,
  names: string[],
  enabled: boolean,
  actions: ViewActions,
): HTMLElement[] {
  const heading = element(doc, "span", "label", "Saved sessions");
  if (names.length === 0) {
    return [heading, element(doc, "span", "hint", "none yet: /save <name> keeps the conversation")];
  }
  const buttons = names.map((name) => {
    const button = element(doc, "button", "session", name);
    button.disabled = !enabled;
    button.addEventListener("click", () => actions.line(`/load ${name}`));
    return button;
  });
  return [heading, ...buttons];
}

// The tools, each a button that switches it. Clicking sends /tools enable|disable <name>, the line the
// user would type. A change applies from the next request.
function toolsPanel(
  doc: Document,
  tools: ToolSwitch[],
  enabled: boolean,
  actions: ViewActions,
): HTMLElement[] {
  const heading = element(doc, "span", "label", "Tools");
  const hint = element(doc, "span", "hint", "a change applies from the next request");
  const buttons = tools.map((tool) => {
    const button = element(doc, "button", "tool", `${tool.name}: ${tool.enabled ? "on" : "off"}`);
    button.disabled = !enabled;
    button.setAttribute("aria-pressed", String(tool.enabled));
    const action = tool.enabled ? "disable" : "enable";
    button.addEventListener("click", () => actions.line(`/tools ${action} ${tool.name}`));
    return button;
  });
  return [heading, hint, ...buttons];
}

// The hook points a profile can have. The same four as HOOK_POINTS in src/core/notes.ts.
type HookPoint = ProfileDetail["hooks"][number]["point"];
const HOOK_POINTS_UI: HookPoint[] = ["sessionStart", "sessionEnd", "turnStart", "turnEnd"];

// One hook row of the editor: its point and its command.
interface HookRow {
  element: HTMLElement;
  point: HTMLSelectElement;
  command: HTMLInputElement;
}

// The profiles, each a button that opens its editor. Clicking sends profileRead.
function profilesPanel(
  doc: Document,
  profiles: ProfileSummary[],
  enabled: boolean,
  actions: ViewActions,
): HTMLElement[] {
  const heading = element(doc, "span", "label", "Profiles");
  if (profiles.length === 0) {
    return [heading, element(doc, "span", "hint", "none yet: /note new profile <name> creates one")];
  }
  const buttons = profiles.map((profile) => {
    const button = element(doc, "button", "session", profile.name);
    button.title = profile.summary;
    button.disabled = !enabled;
    button.addEventListener("click", () => actions.readProfile(profile.name));
    return button;
  });
  return [heading, ...buttons];
}

// A labelled control, for the editor's form.
function labelled(doc: Document, caption: string, control: HTMLElement): HTMLElement {
  const label = doc.createElement("label");
  label.className = "field";
  label.append(element(doc, "span", "", caption), control);
  return label;
}

// The editor's form for one profile. Save sends the edited detail; Cancel only closes the dialog.
// What the editor is opened with: the profile, the tools, whether the page may send, and the actions.
interface EditorOpen {
  profile: ProfileDetail;
  tools: ToolSwitch[];
  sendable(): boolean;
  actions: ViewActions;
}

interface EditorSetup {
  doc: Document;
  profile: ProfileDetail;
  tools: ToolSwitch[];
  canSave(): boolean;
  actions: ViewActions;
  close(): void;
}

function editorForm(setup: EditorSetup): HTMLElement {
  const { doc, profile, tools, canSave, actions, close } = setup;
  const form = doc.createElement("div");
  form.append(element(doc, "h2", "", profile.name));

  const summary = doc.createElement("input");
  summary.type = "text";
  summary.value = profile.summary;
  form.append(labelled(doc, "Summary", summary));

  const toolBoxes = tools.map((tool) => {
    const box = doc.createElement("input");
    box.type = "checkbox";
    box.value = tool.name;
    box.checked = profile.tools === undefined || profile.tools.includes(tool.name);
    return labelled(doc, tool.name, box);
  });
  const toolSet = doc.createElement("fieldset");
  toolSet.append(element(doc, "legend", "", "Tools this profile allows (all checked: no limit)"));
  toolSet.append(...toolBoxes);
  form.append(toolSet);

  const rows: HookRow[] = [];
  const hookSet = doc.createElement("fieldset");
  hookSet.append(element(doc, "legend", "", "Hooks (run at the point, without approval)"));
  const addRow = (point: HookPoint, command: string): void => {
    const row = doc.createElement("div");
    row.className = "hook-row";
    const select = doc.createElement("select");
    for (const option of HOOK_POINTS_UI) {
      const item = doc.createElement("option");
      item.value = option;
      item.textContent = option;
      item.selected = option === point;
      select.append(item);
    }
    const input = doc.createElement("input");
    input.type = "text";
    input.value = command;
    const remove = element(doc, "button", "", "Remove");
    remove.type = "button";
    const entry: HookRow = { element: row, point: select, command: input };
    remove.addEventListener("click", () => {
      rows.splice(rows.indexOf(entry), 1);
      row.remove();
    });
    row.append(select, input, remove);
    rows.push(entry);
    hookSet.append(row);
  };
  for (const hook of profile.hooks) addRow(hook.point, hook.command);
  const addHook = element(doc, "button", "", "Add hook");
  addHook.type = "button";
  addHook.addEventListener("click", () => addRow("sessionStart", ""));
  hookSet.append(addHook);
  form.append(hookSet);

  const text = doc.createElement("textarea");
  text.rows = 12;
  text.value = profile.text;
  form.append(labelled(doc, "Text", text));

  const buttons = doc.createElement("div");
  buttons.className = "buttons";
  const save = element(doc, "button", "send", "Save");
  save.type = "button";
  const cancel = element(doc, "button", "", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", close);
  save.addEventListener("click", () => {
    if (!canSave()) return;
    const detail: ProfileDetail = {
      name: profile.name,
      summary: summary.value.trim(),
      hooks: rows
        .filter((row) => row.command.value.trim() !== "")
        .map((row) => ({
          point: row.point.value as HookPoint,
          command: row.command.value.trim(),
        })),
      text: text.value,
    };
    const boxes = toolBoxes.map((label) => label.querySelector("input") as HTMLInputElement);
    if (!boxes.every((box) => box.checked)) {
      detail.tools = boxes.filter((box) => box.checked).map((box) => box.value);
    }
    actions.writeProfile(detail);
    close();
  });
  buttons.append(save, cancel);
  form.append(buttons);
  return form;
}

// Shows the editor for a profile that was just read, in the dialog.
function openEditor(
  doc: Document,
  editor: HTMLDialogElement,
  opened: EditorOpen,
): void {
  editor.replaceChildren(
    editorForm({
      doc,
      profile: opened.profile,
      tools: opened.tools,
      canSave: opened.sendable,
      actions: opened.actions,
      close: () => editor.close(),
    }),
  );
  editor.showModal();
}

// Builds the page once, then replaces the transcript and the controls on each render.
export function createView(
  doc: Document,
  root: HTMLElement,
  actions: ViewActions,
): View {
  const header = element(doc, "header", "bar", "Vise");
  const status = element(doc, "span", "status", "");
  header.append(status);
  const panel = doc.createElement("section");
  // What the panel was last built from, so an unchanged panel is left alone.
  let panelKey = "";
  panel.className = "sessions";
  const toolPanel = doc.createElement("section");
  toolPanel.className = "sessions";
  // What the tools panel was last built from, so an unchanged panel is left alone.
  let toolKey = "";
  const profilePanel = doc.createElement("section");
  profilePanel.className = "sessions";
  let profileKey = "";
  // The editor: a dialog that opens on each profile the page reads.
  const editor = doc.createElement("dialog");
  editor.className = "profile-editor";
  // Whether the page may send now, as of the last render. The editor's Save checks it when clicked.
  let sendableNow = false;
  let shownProfile: ProfileDetail | undefined;
  const transcript = element(doc, "main", "transcript", "");
  const form = doc.createElement("form");
  form.className = "composer";
  const input = doc.createElement("textarea");
  input.rows = 2;
  input.placeholder = "Message Vise (Enter sends, Shift+Enter adds a line)";
  const send = element(doc, "button", "send", "Send");
  send.type = "submit";
  form.append(input, send);
  root.append(header, panel, toolPanel, profilePanel, transcript, form, editor);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === "" || input.disabled) return;
    input.value = "";
    actions.line(text);
  });

  return {
    render(state) {
      const nearBottom =
        transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
      status.textContent = state.ended
        ? `session ended${state.endError ? `: ${state.endError}` : ""}`
        : LINK_TEXT[state.link];
      transcript.replaceChildren(
        ...state.blocks.map((block) => blockElement(doc, block, actions)),
      );
      const open = openApproval(state);
      const sendable = canSend(state);
      // Rebuilt only when its names or its enabled state change. Rebuilding on every frame would replace a
      // button between the press and the release of a click.
      const key = JSON.stringify([state.sessions, sendable]);
      if (key !== panelKey) {
        panelKey = key;
        panel.replaceChildren(
          ...sessionsPanel(doc, state.sessions, sendable, actions),
        );
      }
      sendableNow = sendable;
      const profilesKey = JSON.stringify([state.profiles, sendable]);
      if (profilesKey !== profileKey) {
        profileKey = profilesKey;
        profilePanel.replaceChildren(
          ...profilesPanel(doc, state.profiles, sendable, actions),
        );
      }
      if (state.profile !== undefined && state.profile !== shownProfile) {
        shownProfile = state.profile;
        openEditor(doc, editor, { profile: state.profile, tools: state.tools, sendable: () => sendableNow, actions });
      }
      const toolsKey = JSON.stringify([state.tools, sendable]);
      if (toolsKey !== toolKey) {
        toolKey = toolsKey;
        toolPanel.replaceChildren(
          ...toolsPanel(doc, state.tools, sendable, actions),
        );
      }
      input.disabled = !sendable;
      send.disabled = !sendable;
      input.placeholder = open
        ? "Answer the question above with its buttons"
        : "Message Vise (Enter sends, Shift+Enter adds a line)";
      if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
    },
  };
}
