import type { Tool } from "../core/engine.ts";

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
        "Read the visible text of a browser tab's current page. Long pages are truncated.",
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
];
