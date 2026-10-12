import { afterAll, describe, expect, test } from "bun:test";
import { createWorkflowPicker } from "../../../packages/frontend/src/menubar/workflow-picker.ts";

function makeStrip() {
  const state = { hidden: true, text: "", children: [] as { tag: string; text: string }[] };
  return {
    state,
    element: {
      set textContent(v: string | null) {
        state.text = v ?? "";
        state.children = [];
      },
      classList: { toggle(_cls: string, hidden: boolean) { state.hidden = hidden; } },
      append(...nodes: { tagName: string; textContent?: string }[]) {
        for (const n of nodes) state.children.push({ tag: n.tagName.toLowerCase(), text: n.textContent ?? "" });
      },
    } as unknown as HTMLElement,
  };
}

function installDocumentStub() {
  const original = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => ({ tagName: tag.toUpperCase(), className: "", textContent: "", addEventListener: () => {} }),
  } as unknown as Document;
  return () => {
    globalThis.document = original;
  };
}

/** Build a picker with a recording strip; the workflows cache is set via observe before calling running. */
function picker(workflows: { name: string; scope: string }[]) {
  const { element, state } = makeStrip();
  const p = createWorkflowPicker(
    () => {},
    () => {},
    element,
    () => {},
    () => {},
    () => {},
  );
  if (workflows.length > 0) p.observe({ type: "workflows", workflows });
  return { p, state };
}

describe("workflow picker running()", () => {
  const restoreDocument = installDocumentStub();
  afterAll(restoreDocument);

  test("null line hides the strip", () => {
    const { p, state } = picker([]);
    p.running("/workflow commit"); // show it first
    expect(state.hidden).toBe(false);
    p.running(null);
    expect(state.hidden).toBe(true);
  });

  test("explicit /workflow <name> shows the strip", () => {
    const { p, state } = picker([]);
    p.running("/workflow commit");
    expect(state.hidden).toBe(false);
    expect(state.children.some((c) => c.text === "Running workflow commit…")).toBe(true);
  });

  test("/workflow init hides the strip", () => {
    const { p, state } = picker([]);
    p.running("/workflow init");
    expect(state.hidden).toBe(true);
  });

  test("shortcut with populated cache shows the strip", () => {
    const { p, state } = picker([{ name: "commit", scope: "project" }]);
    p.running("/commit");
    expect(state.hidden).toBe(false);
    expect(state.children.some((c) => c.text === "Running workflow commit…")).toBe(true);
  });

  test("shortcut with empty cache hides the strip", () => {
    const { p, state } = picker([]);
    p.running("/commit");
    expect(state.hidden).toBe(true);
  });

  test("non-workflow command hides the strip", () => {
    const { p, state } = picker([{ name: "commit", scope: "project" }]);
    p.running("/help");
    expect(state.hidden).toBe(true);
  });
});
