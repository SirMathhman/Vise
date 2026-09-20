import { resolve } from "node:path";
import type { AppContext } from "../context.js";
import { AppError, badRequest } from "../errors.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";
import { type PageActionName, pageActions } from "./browser/actions.js";
import { runCommand, runShellCommand } from "./llmCommand.js";
import {
  createDirectory,
  createFile,
  deleteDirectory,
  deleteFile,
  editFileRange,
  listDirectory,
  readFileRange,
} from "./llmFs.js";
import { findFiles, searchFiles } from "./llmSearch.js";
import type { LlmToolHandler } from "./llmToolTypes.js";

/**
 * create_subagent spawns a nested chat-completion loop, which only the panel
 * can do (it alone talks to the LLM proxy) — so it is fully handled and
 * intercepted client-side and never forwarded to this route. This handler
 * exists only to satisfy the Record<LlmToolName, LlmToolHandler>
 * exhaustiveness check below; reaching it means the panel's interception was
 * bypassed, which is itself a bug worth surfacing to the model.
 */
const createSubagent: LlmToolHandler = async () => {
  throw badRequest(
    "create_subagent must be handled by the panel and never reaches the backend"
  );
};

/**
 * ask_questions is fully handled client-side by the panel (it renders an
 * interactive question card and waits for the user's answer), so it is never
 * forwarded to this route. This handler exists only to satisfy the
 * Record<LlmToolName, LlmToolHandler> exhaustiveness check below; reaching it
 * means the panel's interception was bypassed, which is itself a bug worth
 * surfacing to the model.
 */
const askQuestions: LlmToolHandler = async () => {
  throw badRequest(
    "ask_questions must be handled by the panel and never reaches the backend"
  );
};

/**
 * use_skill is fully handled client-side by the panel (it looks up a named
 * skill's content in the browser's skill store and returns it), so it is
 * never forwarded to this route. This handler exists only to satisfy the
 * Record<LlmToolName, LlmToolHandler> exhaustiveness check below; reaching
 * it means the panel's interception was bypassed, which is itself a bug
 * worth surfacing to the model.
 */
const useSkill: LlmToolHandler = async () => {
  throw badRequest(
    "use_skill must be handled by the panel and never reaches the backend"
  );
};

/**
 * The tools available to the model, keyed by the name the model uses. The keys
 * are checked against the shared LlmToolName union, so a renamed or misspelled
 * tool name here is a compile error. The handlers themselves live in sibling
 * modules, grouped by concern (llmCommand.ts: the shell; llmFs.ts: file CRUD;
 * llmSearch.ts: find_files/search_files) — this file is only the registry and
 * the two HTTP routes that dispatch into it.
 */
const moduleTools: Record<string, LlmToolHandler> = {
  list_directory: listDirectory,
  find_files: findFiles,
  search_files: searchFiles,
  read_file: readFileRange,
  edit_file: editFileRange,
  create_directory: createDirectory,
  create_file: createFile,
  delete_file: deleteFile,
  delete_directory: deleteDirectory,
  run_command: runCommand,
  create_subagent: createSubagent,
  ask_questions: askQuestions,
  use_skill: useSkill,
};

/**
 * Execute a tool call on the backend and return the result as model-readable
 * text. Unknown tools and thrown errors are returned as 200 with an error
 * string so the model can read the problem and adapt, rather than the client
 * tool loop crashing.
 */
export function llmToolRoutes(ctx: AppContext): Route[] {
  const root = resolve(ctx.rootPath);
  const browser = ctx.browserSession;
  const tools: Record<string, LlmToolHandler> = {
    ...moduleTools,
    browser_open: browser.open,
    browser_snapshot: browser.snapshot,
    browser_dialog: browser.dialog,
    browser_screenshot: browser.screenshot,
  };
  // The page-acting browser tools all route through the session's one `act`.
  for (const name of Object.keys(pageActions) as PageActionName[]) {
    tools[name] = (args) => browser.act(name, args);
  }
  return [
    {
      method: "POST",
      pattern: "/api/llm/tool",
      handler: async (_req, res, _params, body) => {
        const payload = (body ?? {}) as {
          name?: unknown;
          arguments?: unknown;
        };
        const name = typeof payload.name === "string" ? payload.name : "";
        let args: Record<string, unknown> = {};
        if (typeof payload.arguments === "string") {
          try {
            args = JSON.parse(payload.arguments || "{}") as Record<
              string,
              unknown
            >;
          } catch {
            args = {};
          }
        }

        const tool = (tools as Record<string, LlmToolHandler>)[name];
        if (!tool) {
          sendJson(res, 200, { result: `Error: unknown tool "${name}".` });
          return;
        }
        try {
          const out = await tool(args, root);
          if (typeof out === "string") {
            sendJson(res, 200, { result: out });
          } else {
            sendJson(res, 200, { result: out.text, images: out.images });
          }
        } catch (err) {
          const message =
            err instanceof AppError ? err.message : (err as Error).message;
          sendJson(res, 200, { result: `Error: ${message}` });
        }
      },
    },
    {
      // Runs a command and returns its stdout/stderr separately, unlike
      // /api/llm/tool's run_command (which formats them into one
      // model-readable string). Not part of the model tool surface — used by
      // the panel's own hooks (e.g. the end-of-turn check, which must tell
      // stdout from stderr to decide whether to block the turn), so unlike
      // /api/llm/tool it does not catch errors into a 200 response: a bad
      // request or a spawn failure surfaces as a normal thrown AppError, the
      // same as every other non-tool route.
      method: "POST",
      pattern: "/api/llm/hook-command",
      handler: async (_req, res, _params, body) => {
        const payload = (body ?? {}) as { command?: unknown };
        const command =
          typeof payload.command === "string" ? payload.command : "";
        if (!command) throw badRequest("command is required");
        const r = await runShellCommand(command, root);
        sendJson(res, 200, {
          stdout: r.stdout,
          stderr: r.stderr,
          truncated: r.truncated,
          timedOut: r.timedOut,
        });
      },
    },
  ];
}
