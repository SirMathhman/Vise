import type {
  ApprovalAnswer,
  ProfileDetail,
  ProfileSummary,
  ToolSwitch,
} from "../../protocol/protocol.ts";
import {
  canSend,
  openApproval,
  toolsAfterEdit,
  type ApprovalBlock,
  type AskBlock,
  type Block,
  type ViewState,
} from "./state.ts";
import { createMcpSection, panelBox, type McpActions } from "./mcp-view.ts";
import { createProvidersSection, type ProvidersActions } from "./providers/providers-view.ts";
import { createTreeSection, type TreeActions } from "./files/tree-view.ts";
import { createFileViewer, type FileActions } from "./files/file-view.ts";
import { renderMarkdown } from "./render/markdown-dom.ts";
import { applySplit, columns } from "./layout/columns.ts";
import { themeControl } from "./theme/theme.ts";
import { earlierButton, type RecentActions } from "./transcript/recent.ts";
import { createModelPicker } from "./models/model-picker.ts";

// What the view asks the page to do. The page sends the line or the answer to the server.
export interface ViewActions extends McpActions, TreeActions, FileActions, ProvidersActions, RecentActions {
  line(text: string): void;
  changeFolder(path: string): void;
  pickFolder(): void;
  answerAsk(id: number, chosen: number[], text: string): void;
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

// A question the model asked: a checkbox per choice, a box for an answer of the user's own, and Send.
// Once it is answered the card shows the answer and no controls.
function askCard(doc: Document, block: AskBlock, actions: ViewActions): HTMLElement {
  const card = element(doc, "section", "block ask", "");
  card.append(element(doc, "p", "label", block.question));
  if (block.answer !== undefined) {
    card.append(element(doc, "p", "answered", `answered: ${block.answer}`));
    return card;
  }
  const boxes = block.choices.map((choice, index) => {
    const box = doc.createElement("input");
    box.type = "checkbox";
    box.value = String(index);
    return labelled(doc, choice, box);
  });
  const own = doc.createElement("input");
  own.type = "text";
  own.placeholder = "or type your own answer";
  const send = element(doc, "button", "send", "Send");
  send.type = "button";
  send.addEventListener("click", () => {
    const chosen = boxes
      .map((label) => label.querySelector("input") as HTMLInputElement)
      .filter((box) => box.checked)
      .map((box) => Number(box.value));
    if (chosen.length === 0 && own.value.trim() === "") return;
    actions.answerAsk(block.id, chosen, own.value);
  });
  card.append(...boxes, own, send);
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
    case "reply": {
      const node = doc.createElement("div");
      node.className = "block reply";
      node.append(...renderMarkdown(doc, block.text));
      return node;
    }
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
    case "ask":
      return askCard(doc, block, actions);
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
  // The rows sit in their own box, so the Add hook button stays below them.
  const hookRows = doc.createElement("div");
  hookSet.append(hookRows);
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
    hookRows.append(row);
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
    const tools = toolsAfterEdit(
      profile.tools,
      boxes.map((box) => box.value),
      boxes.filter((box) => box.checked).map((box) => box.value),
    );
    if (tools !== undefined) detail.tools = tools;
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

// The New conversation button. It sends /new, the line the user would type, so the page keeps to lines and approvals.
function newConversationButton(doc: Document, actions: ViewActions): HTMLButtonElement {
  const button = element(doc, "button", "new-chat", "New conversation");
  button.type = "button";
  button.addEventListener("click", () => actions.line("/new"));
  return button;
}

// The folder the session works in, with a box for another folder. Switch restarts the session there.
interface FolderBar {
  element: HTMLElement;
  path: HTMLElement;
  input: HTMLInputElement;
  go: HTMLButtonElement;
  pick: HTMLButtonElement;
}

function folderBar(doc: Document, actions: ViewActions): FolderBar {
  const element = doc.createElement("section");
  element.className = "folder";
  const label = doc.createElement("span");
  label.className = "label";
  label.textContent = "Folder";
  const path = doc.createElement("span");
  path.className = "hint";
  const input = doc.createElement("input");
  input.type = "text";
  input.placeholder = "another folder, as a full path";
  const go = doc.createElement("button");
  go.type = "button";
  go.textContent = "Switch";
  go.addEventListener("click", () => {
    const folder = input.value.trim();
    if (folder === "") return;
    input.value = "";
    actions.changeFolder(folder);
  });
  const pick = doc.createElement("button");
  pick.type = "button";
  pick.textContent = "Pick folder";
  pick.addEventListener("click", () => actions.pickFolder());
  element.append(label, path, input, go, pick);
  return { element, path, input, go, pick };
}

// The Undo button. It sends /undo, the line the user would type, so the page keeps to lines and approvals.
function undoButton(doc: Document, actions: ViewActions): HTMLButtonElement {
  const button = element(doc, "button", "undo-last", "Undo");
  button.type = "button";
  button.addEventListener("click", () => actions.line("/undo"));
  return button;
}

// Builds the page once, then replaces the transcript and the controls on each render.
// The composer: Enter sends the line, Shift+Enter adds one, and the form's submit sends the typed text.
function wireComposer(form: HTMLFormElement, input: HTMLTextAreaElement, actions: ViewActions): void {
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
}

export function createView(
  doc: Document,
  root: HTMLElement,
  actions: ViewActions,
): View {
  const header = element(doc, "header", "bar", "Vise");
  const status = element(doc, "span", "status", "");
  const newChat = newConversationButton(doc, actions);
  const undo = undoButton(doc, actions);
  const models = createModelPicker(doc, { chooseModel: (name) => actions.line(`/model ${name}`) }); header.append(status, models.element, themeControl(doc), undo, newChat);
  const folder = folderBar(doc, actions);
  const files = createTreeSection(doc, actions);
  const fileViewer = createFileViewer(doc, actions);
  // Whether the three columns were shown at the last render.
  let splitShown = false;
  const panel = panelBox(doc);
  // What the panel was last built from, so an unchanged panel is left alone.
  let panelKey = "";
  const toolPanel = panelBox(doc);
  // What the tools panel was last built from, so an unchanged panel is left alone.
  let toolKey = "";
  const profilePanel = panelBox(doc);
  let profileKey = "";
  // The editor: a dialog that opens on each profile the page reads.
  const editor = doc.createElement("dialog");
  editor.className = "profile-editor";
  // Whether the page may send now, as of the last render. The editor's Save checks it when clicked.
  let sendableNow = false;
  let shownProfile: ProfileDetail | undefined;
  const mcp = createMcpSection(doc, actions); const providers = createProvidersSection(doc, actions);
  const transcript = element(doc, "main", "transcript", "");
  const form = doc.createElement("form");
  form.className = "composer";
  const input = doc.createElement("textarea");
  input.rows = 2;
  input.placeholder = "Message Vise (Enter sends, Shift+Enter adds a line)";
  const send = element(doc, "button", "send", "Send");
  send.type = "submit";
  form.append(input, send);
  const workspace = columns(doc, {
    tree: files.element, file: fileViewer.element,
    panels: [panel.element, toolPanel.element, profilePanel.element, mcp.section, providers.section], transcript, composer: form,
  });
  root.append(header, folder.element, workspace, editor, mcp.dialog, providers.dialog);

  wireComposer(form, input, actions);

  return {
    render(state) {
      // The chat body scrolls in the three columns; otherwise the page flows and nothing here scrolls.
      const follow = transcript.parentElement ?? transcript;
      const nearBottom = follow.scrollHeight - follow.scrollTop - follow.clientHeight < 80;
      status.textContent = state.ended
        ? `session ended${state.endError ? `: ${state.endError}` : ""}`
        : LINK_TEXT[state.link];
      const hidden = Math.max(0, state.blocks.length - state.recent);
      transcript.replaceChildren(...(hidden > 0 ? [earlierButton(doc, hidden, actions)] : []), ...state.blocks.slice(hidden).map((block) => blockElement(doc, block, actions)));
      const open = openApproval(state);
      const sendable = canSend(state);
      // Rebuilt only when its names or its enabled state change. Rebuilding on every frame would replace a
      // button between the press and the release of a click.
      const key = JSON.stringify([state.sessions, sendable]);
      if (key !== panelKey) {
        panelKey = key;
        panel.show("Saved sessions", state.sessions.length, sessionsPanel(doc, state.sessions, sendable, actions));
      }
      sendableNow = sendable;
      files.update(state.trees, state.expanded);
      fileViewer.update({ openFiles: state.openFiles, file: state.file });
      splitShown = applySplit(root, [panel.element, toolPanel.element, profilePanel.element, mcp.section, providers.section], state.openFiles.length > 0, splitShown);
      const profilesKey = JSON.stringify([state.profiles, sendable]);
      if (profilesKey !== profileKey) {
        profileKey = profilesKey;
        profilePanel.show("Profiles", state.profiles.length, profilesPanel(doc, state.profiles, sendable, actions));
      }
      mcp.update(state.mcp, sendable, () => sendableNow); providers.update(state.providers, sendable); models.update(state.currentModel, state.models, sendable);
      if (state.profile !== undefined && state.profile !== shownProfile) {
        shownProfile = state.profile;
        openEditor(doc, editor, { profile: state.profile, tools: state.tools, sendable: () => sendableNow, actions });
      }
      const toolsKey = JSON.stringify([state.tools, sendable]);
      if (toolsKey !== toolKey) {
        toolKey = toolsKey;
        toolPanel.show("Tools", state.tools.length, toolsPanel(doc, state.tools, sendable, actions));
      }
      newChat.disabled = !sendable;
      undo.disabled = !sendable;
      folder.path.textContent = state.folder ?? "";
      folder.input.disabled = !sendable;
      folder.go.disabled = !sendable;
      folder.pick.disabled = !sendable;
      input.disabled = !sendable;
      send.disabled = !sendable;
      input.placeholder = open
        ? "Answer the question above with its buttons"
        : "Message Vise (Enter sends, Shift+Enter adds a line)";
      if (nearBottom) follow.scrollTop = follow.scrollHeight;
    },
  };
}
