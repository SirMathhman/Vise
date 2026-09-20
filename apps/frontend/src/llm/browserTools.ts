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
      'Type text into, and/or press a key on, the active browser page. With `n` (an element number from the latest snapshot) and `text`: for text fields and textareas this fills the field; for a select it chooses an option matching the text; for a checkbox or radio it checks it. With `key` (a Playwright key name such as "Enter", "Tab", "Escape", or "Control+A"): the key is pressed on element `n` after any typing, or, if you give only `key`, on whatever currently has focus. Provide `text`, `key`, or both. A fresh snapshot is returned after the action. Use this to fill search boxes and forms, submit with Enter, and use keyboard shortcuts.',
    parameters: {
      type: "object",
      properties: {
        n: {
          type: "number",
          description:
            "The element number from the latest snapshot (0-based). Required when typing text; optional when only pressing a key.",
        },
        text: {
          type: "string",
          description:
            "The text to type into the element (or the option label for a select).",
        },
        key: {
          type: "string",
          description:
            'A key or shortcut to press, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+A".',
        },
      },
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
 * Go back, forward, or reload on the active browser page.
 */
const browserNavigate: LlmTool = {
  type: "function",
  function: {
    name: "browser_navigate",
    description:
      'Navigate the active browser page through its history or reload it: action "back", "forward", or "reload". To open a new URL use browser_open instead. A fresh snapshot is returned afterwards.',
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: 'One of "back", "forward", or "reload".',
        },
      },
      required: ["action"],
    },
  },
};

/**
 * Read the visible text content of the active browser page.
 */
const browserRead: LlmTool = {
  type: "function",
  function: {
    name: "browser_read",
    description:
      "Return the visible text content of the active browser page (its title, URL, and body text, capped at 20,000 characters). Use this to read an article, a result, or any content that the interactive-element snapshot does not show.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

/**
 * Run a Playwright snippet against the active browser page.
 */
const browserRunCode: LlmTool = {
  type: "function",
  function: {
    name: "browser_run_code",
    description:
      "Run a JavaScript snippet against the active browser page. The snippet is the body of an async function with the Playwright `page` object in scope, so use `await` and `return` a JSON-serializable value, e.g. `return await page.locator('h1').innerText();`. Runs in a sandboxed Node process, not in the page (use page.evaluate to run code inside the page), with no file-system or child-process access; only `page` is useful. Times out after 30 seconds (the process is killed). The returned value is reported, followed by a fresh snapshot. Use this only when the other browser tools cannot do what you need (e.g. a complex selector, waiting for something, or reading a computed value).",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "The async function body to run, with `page` (a Playwright Page) in scope.",
        },
      },
      required: ["code"],
    },
  },
};

/**
 * Capture a screenshot of the active browser page as an image the model sees.
 */
const browserScreenshot: LlmTool = {
  type: "function",
  function: {
    name: "browser_screenshot",
    description:
      "Capture a screenshot of the active browser page and attach it as an image you can see. Use this to check how a page actually looks (layout, images, colors, charts, canvas content) when the text snapshot and browser_read are not enough. Requires a vision-capable model. Only your most recent screenshot stays in context, so note what you need from it before taking another.",
    parameters: {
      type: "object",
      properties: {
        full_page: {
          type: "boolean",
          description:
            "Capture the whole scrollable page instead of just the visible viewport. Defaults to false.",
        },
      },
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
  browserNavigate,
  browserRead,
  browserRunCode,
  browserScreenshot,
  browserDialog,
];
