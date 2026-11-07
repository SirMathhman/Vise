import type { Writable } from "node:stream";
import { sanitize } from "../core/tools.ts";
import type { ServerEvent } from "../protocol/protocol.ts";

// Hook output longer than this is cut short on the terminal. The whole output still goes to the model.
const HOOK_SHOWN_LIMIT = 4000;

// Writes backend events to the terminal. Model text, tool lines, and approval previews are sanitized
// here, so control characters in them cannot move or overwrite the screen.
export interface Renderer {
  render(event: ServerEvent): void;
}

export function createRenderer(output: Writable): Renderer {
  // The thinking line of the current request. It is redrawn in place until its count is final.
  let thinkingShown = false;
  let thinkingOpen = false;
  let thinkingWidth = 0;
  return {
    render(event: ServerEvent): void {
      switch (event.kind) {
        case "text":
          if (thinkingOpen && event.text !== "") {
            output.write("\n");
            thinkingOpen = false;
          }
          output.write(sanitize(event.text));
          return;
        case "replyEnd":
          output.write("\n");
          return;
        case "thinking": {
          const text = `thinking: ~${event.approximate} tokens`;
          thinkingShown = true;
          thinkingOpen = true;
          thinkingWidth = Math.max(thinkingWidth, text.length);
          output.write(`\r${text.padEnd(thinkingWidth)}`);
          return;
        }
        case "thinkingDone": {
          if (thinkingShown) {
            const text = event.exact
              ? `thinking: ${event.tokens} tokens`
              : `thinking: ~${event.tokens} tokens`;
            output.write(
              `${thinkingOpen ? "\r" : ""}${text.padEnd(thinkingWidth)}\n`,
            );
          }
          thinkingShown = false;
          thinkingOpen = false;
          thinkingWidth = 0;
          return;
        }
        case "toolCall":
          output.write(`\n${sanitize(event.description)}\n`);
          return;
        case "toolSkipped":
          output.write(
            `\n${sanitize(event.description)} did not run: the session ended\n`,
          );
          return;
        case "approvalRequest":
          output.write(`${sanitize(event.preview)}\napply? (y/n) `);
          return;
        case "hookOutput": {
          if (event.text === "") return;
          const shown = sanitize(event.text).slice(0, HOOK_SHOWN_LIMIT);
          output.write(
            `${shown}${event.text.length > HOOK_SHOWN_LIMIT ? "\n[output cut short]" : ""}\n`,
          );
          return;
        }
        case "notice":
          output.write(`${sanitize(event.text)}\n`);
          return;
        case "error":
          output.write(`error: ${sanitize(event.message)}\n`);
          return;
        case "history":
          for (const message of event.messages) {
            const prefix = message.role === "user" ? "> " : "";
            output.write(`${prefix}${sanitize(message.text)}\n`);
          }
          return;
        case "approvalAnswered":
        case "sessions":
        case "tools":
        case "profiles":
        case "profile":
        case "ready":
        case "ended":
          return;
      }
    },
  };
}
