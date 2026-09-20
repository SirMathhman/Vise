/**
 * Definitions of the browser tools the LLM panel exposes to the model (the
 * model-driven Chrome page: see routes/browser/ on the backend). Split out of
 * tools.ts, which spreads `browserToolDefinitions` into the full tool list.
 */
import type { LlmTool } from "../api/client.js";

/**
 * Open (or navigate the existing) browser window to a URL and return a
 * numbered snapshot of its interactive elements. This is the entry point for
 * the model-driven browser: a separate, visible Chrome window (not the panel's
 * own cross-origin URL tabs) that the model can click and type into.
 */
const browserOpen: LlmTool = {
  type: "function",
  function: {
    name: "browser_open",
    description:
      "Open a URL in a visible browser window and return a numbered snapshot of the page's interactive elements (buttons, links, text fields, etc.). This is how you act on a web page: open it, read the snapshot, then use browser_click or browser_type with an element number from that snapshot. Each action also returns a fresh snapshot, so always base your next element number on the latest one. Use this when the user asks you to interact with a web page (click a button, fill a form, submit, etc.).",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The URL to open, e.g. https://example.com. A bare host like www.example.com is accepted.",
        },
      },
      required: ["url"],
    },
  },
};

/**
 * Re-read the active browser page's interactive elements. Use this to get a
 * fresh element list after any action, or to re-orient if the page changed.
 */
const browserSnapshot: LlmTool = {
  type: "function",
  function: {
    name: "browser_snapshot",
    description:
      "Return a fresh numbered snapshot of the active browser page's interactive elements (title, URL, and the element list). Use this to re-read the page after it has changed, or if you are unsure of the current element numbers. browser_open, browser_click, and browser_type each return a fresh snapshot already, so you usually do not need to call this separately.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

/**
 * Click the interactive element with the given number from the current page.
 */
const browserClick: LlmTool = {
  type: "function",
  function: {
    name: "browser_click",
    description:
      'Click the interactive element with the given number (from the latest snapshot returned by browser_open, browser_snapshot, or a prior action) on the active browser page. The element number is the index shown in the snapshot, e.g. "2) [button] Submit" is element 2. A fresh snapshot is returned after the click so you can act on the result. Use this to click buttons, links, toggles, and other clickable elements.',
    parameters: {
      type: "object",
      properties: {
        n: {
          type: "number",
          description: "The element number from the latest snapshot (0-based).",
        },
      },
      required: ["n"],
    },
  },
};

/**
 * Type text into the interactive element with the given number from the
 * current page.
 */
const browserType: LlmTool = {
  type: "function",
  function: {
    name: "browser_type",
    description:
      "Type text into the interactive element with the given number (from the latest snapshot) on the active browser page. For text fields and textareas this fills the field; for a select it chooses an option matching the text; for a checkbox or radio it checks it. A fresh snapshot is returned after the action. Use this to fill search boxes, form fields, and other inputs.",
    parameters: {
      type: "object",
      properties: {
        n: {
          type: "number",
          description: "The element number from the latest snapshot (0-based).",
        },
        text: {
          type: "string",
          description:
            "The text to type into the element (or the option label for a select).",
        },
      },
      required: ["n", "text"],
    },
  },
};

/**
 * Drag one interactive element onto another on the current page.
 */
const browserDrag: LlmTool = {
  type: "function",
  function: {
    name: "browser_drag",
    description:
      "Drag the element numbered `from` (from the latest snapshot) and drop it onto the element numbered `to` on the active browser page, using real mouse press/move/release events (so HTML5 drag-and-drop and drag libraries respond). Both numbers come from the same snapshot; draggable elements are listed as [draggable]. A fresh snapshot is returned after the drop. Use this to reorder list items, move cards between columns, or drop a file-like item onto a target.",
    parameters: {
      type: "object",
      properties: {
        from: {
          type: "number",
          description:
            "The number of the element to pick up (0-based, from the latest snapshot).",
        },
        to: {
          type: "number",
          description:
            "The number of the element to drop onto (0-based, from the latest snapshot).",
        },
      },
      required: ["from", "to"],
    },
  },
};

/**
 * Hover the mouse over the interactive element with the given number, e.g. to
 * reveal a dropdown menu or tooltip.
 */
const browserHover: LlmTool = {
  type: "function",
  function: {
    name: "browser_hover",
    description:
      "Move the mouse over the interactive element with the given number (from the latest snapshot) on the active browser page, without clicking. Use this to reveal content that only appears on hover, such as dropdown menus and tooltips. A fresh snapshot is returned afterwards, so newly revealed elements can be acted on.",
    parameters: {
      type: "object",
      properties: {
        n: {
          type: "number",
          description: "The element number from the latest snapshot (0-based).",
        },
      },
      required: ["n"],
    },
  },
};

/**
 * Accept or dismiss the JavaScript dialog (alert/confirm/prompt/beforeunload)
 * the active browser page has open.
 */
const browserDialog: LlmTool = {
  type: "function",
  function: {
    name: "browser_dialog",
    description:
      'Accept or dismiss the JavaScript dialog (alert, confirm, prompt, or beforeunload) that the active browser page has open. When an action opens a dialog, its result tells you so (with the dialog type and message) and the page is blocked until you answer: every other browser tool refuses to run while a dialog is open. Use action "accept" (OK) or "dismiss" (Cancel); for a prompt, pass `text` to accept with that answer. A fresh snapshot is returned afterwards.',
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            'Either "accept" (press OK) or "dismiss" (press Cancel / close).',
        },
        text: {
          type: "string",
          description:
            "For a prompt dialog being accepted: the text to enter. Ignored otherwise.",
        },
      },
      required: ["action"],
    },
  },
};

/** The browser tool definitions, in the order the model sees them. */
export const browserToolDefinitions: LlmTool[] = [
  browserOpen,
  browserSnapshot,
  browserClick,
  browserType,
  browserDrag,
  browserHover,
  browserDialog,
];
