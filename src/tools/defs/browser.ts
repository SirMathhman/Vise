import type { Tool } from "../../core/engine.ts";

/** Model-facing definitions for the integrated-browser tools (handlers: `browser.ts`). */
export const browserTools: Tool[] = [
  {
    type: "function",
    function: {
      name: "browser_open",
      description:
        "Open a new tab in the integrated browser (a real Chromium) at an http(s) URL and wait for it to load. Returns the tab number, title and URL. Use the tab number with browser_navigate and browser_read.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The http(s) URL to open",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_tabs",
      description:
        "List the tabs open in the integrated browser, one per line with their tab number, title and URL.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description:
        "Navigate an existing browser tab to a new http(s) URL, wait for it to load, and return the tab's new title and URL.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          url: {
            type: "string",
            description: "The http(s) URL to navigate to",
          },
        },
        required: ["tab", "url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_read",
      description:
        "Read a browser tab's current page: its visible text followed by an outline of the visible interactive elements, each with a ref such as e3. The outline is always shown in full. A long page's text is saved to a temp file and only its start is shown: search or page through the rest with search_temp and read_temp. After an action that changes the page without loading it (a search, a filter), first call browser_wait_for_text with a word you expect in the new content (or browser_wait_for_idle if you cannot name one); otherwise the read may show the old content. Pass a ref to browser_click, browser_hover, browser_drag or browser_type. Refs are valid until the page navigates; read again for fresh ones.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
        },
        required: ["tab"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_wait_for_text",
      description:
        "Wait until some text is visible on a browser tab's page (case-insensitive), then return. Use it after an action that updates the page without loading a new one, such as submitting a search, to be sure the new content is there before browser_read. Fails after the timeout if the text never appears.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          text: {
            type: "string",
            description: "The text to wait for",
          },
          timeout_seconds: {
            type: "number",
            description: "How long to wait at most, up to 60. Default 10.",
          },
        },
        required: ["tab", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_wait_for_text_gone",
      description:
        "Wait until some text is no longer visible on a browser tab's page (case-insensitive), then return. Use it to wait out a 'Loading...' message or a spinner label. Fails after the timeout if the text stays.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          text: {
            type: "string",
            description: "The text that should disappear",
          },
          timeout_seconds: {
            type: "number",
            description: "How long to wait at most, up to 60. Default 10.",
          },
        },
        required: ["tab", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_wait_for_idle",
      description:
        "Wait until a browser tab's page has stopped changing (its visible text unchanged for about half a second), then return. Use it only when there is no particular text to wait for; prefer browser_wait_for_text, because a page can sit unchanged for a moment before its update starts (a page that has not changed at all is only called settled after 1.5 seconds). It cannot see changes that leave the visible text alone, such as images. A page that keeps updating on its own never settles; the wait then ends after the timeout and says so.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          timeout_seconds: {
            type: "number",
            description: "How long to wait at most, up to 60. Default 10.",
          },
        },
        required: ["tab"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Click an element in a browser tab, named by its ref from browser_read. Scrolls it into view first. If the click opens a JavaScript dialog the result says so; answer it with browser_handle_dialog.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          ref: {
            type: "string",
            description: "Element ref from browser_read, e.g. e3",
          },
        },
        required: ["tab", "ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_hover",
      description:
        "Move the mouse over an element in a browser tab, named by its ref from browser_read (reveals hover menus and tooltips).",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          ref: {
            type: "string",
            description: "Element ref from browser_read, e.g. e3",
          },
        },
        required: ["tab", "ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_upload",
      description:
        "Attach local files to a file upload field in a browser tab (a resume, a photo). A file picker cannot be driven with browser_click, so use this instead. 'ref' is the file input or the upload button/label next to it, from browser_read; 'paths' are the files on this computer (relative to the working directory, or absolute). The page's own handlers run as if the user had chosen the files; then click the page's submit/next button as usual.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          ref: {
            type: "string",
            description:
              "Ref of the file input, or of the upload button or label for it, from browser_read",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Paths of the files to attach",
          },
        },
        required: ["tab", "ref", "paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_drag",
      description:
        "Drag one element onto another in a browser tab, both named by refs from browser_read.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          from_ref: {
            type: "string",
            description: "Ref of the element to pick up",
          },
          to_ref: {
            type: "string",
            description: "Ref of the element to drop onto",
          },
        },
        required: ["tab", "from_ref", "to_ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description:
        "Type text into an element in a browser tab (or into the currently focused element when ref is omitted), then optionally press a key. Keys: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          ref: {
            type: "string",
            description:
              "Ref of the field to type into (optional; defaults to the focused element)",
          },
          text: {
            type: "string",
            description: "Text to type (may be empty when only pressing a key)",
          },
          replace: {
            type: "boolean",
            description:
              "Select the field's existing contents first so the text replaces them. Default false.",
          },
          key: {
            type: "string",
            description: "A key to press after typing, e.g. Enter to submit",
          },
        },
        required: ["tab"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_handle_dialog",
      description:
        "Respond to a JavaScript dialog (alert, confirm, prompt) that is blocking a browser tab. Other actions on the tab fail until it is answered.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          accept: {
            type: "boolean",
            description: "true to accept/OK (default), false to dismiss/cancel",
          },
          prompt_text: {
            type: "string",
            description: "Answer to give a prompt dialog",
          },
        },
        required: ["tab"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_run_code",
      description:
        "Run a Playwright snippet against a browser tab. The snippet is the body of an async function with `page` (a Playwright Page) in scope; `return` a value to get it back as JSON. Example: return await page.title(). Times out after 30 seconds. WARNING: the snippet runs in a Node process with the full privileges of the user (file system, network, child processes), not just in the page. Disabled by default; the user enables it with /tool browser_run_code enable. Prefer the other browser tools for simple actions.",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          code: {
            type: "string",
            description:
              "JavaScript body using `page`, e.g. \"await page.getByRole('button', {name: 'Save'}).click()\"",
          },
        },
        required: ["tab", "code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Take a screenshot of a browser tab: the picture is shown to you with this tool's result. Use it to check how a page or a UI you are building actually looks (layout, colours, spacing, whether something rendered), which the text from browser_read cannot tell you. full_page captures the whole scrollable page instead of just the visible part (not available in the Firefox extension, which shows only the visible part).",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "integer",
            description: "Tab number from browser_open or browser_tabs",
          },
          full_page: {
            type: "boolean",
            description:
              "Capture the whole page, not just the visible part (default false)",
          },
        },
        required: ["tab"],
      },
    },
  },
];
