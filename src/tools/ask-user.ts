import type { Interface } from "node:readline";
import { createInterface } from "node:readline";
import { red } from "../output/color.ts";

/**
 * Edge-owned interface for asking the user a question mid-turn. The LLM
 * calls the `ask_user` tool; the edge handler delegates to this
 * implementation, which prompts the user and returns their answer as a
 * string. The core never references this type — it only sees the
 * ToolRunner's string result (invariant #4).
 */
/**
 * The request payload for a single `UserPrompter.ask` call. A parameter
 * object so the interface stays stable as the ask_user tool grows more
 * knobs (e.g. timeouts, required flags) — no positional parameter ripples.
 */
export interface AskRequest {
  /** The free-form question to display. */
  question: string;
  /**
   * Predefined choices to display alongside the question. Empty array
   * means free-form only.
   */
  options: string[];
  /**
   * When true, the user may select more than one choice (separating
   * numbers with commas in their reply). Defaults to false.
   */
  multiSelect?: boolean;
}

export interface UserPrompter {
  /** Ask the user a question and return their answer. */
  ask(request: AskRequest): Promise<string>;
}

/**
 * Edge implementation of `UserPrompter`. Pauses the main REPL readline
 * interface for the duration of the prompt so no lines are queued into the
 * turn chain, opens a one-shot readline on stdin, writes the prompt, and
 * resolves with the user's line. On a readline error (e.g. EOF) it resolves
 * with an empty string so the turn can continue.
 */
export class RlUserPrompter implements UserPrompter {
  constructor(private readonly mainRl: Interface) {}

  ask({ question, options, multiSelect = false }: AskRequest): Promise<string> {
    return new Promise((resolve) => {
      this.mainRl.pause();

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      // Build the prompt text: the question, then numbered options if any.
      const lines: string[] = [question];
      if (options.length > 0) {
        lines.push("");
        options.forEach((opt, i) => {
          lines.push(`  ${i + 1}. ${opt}`);
        });
        lines.push("");
      }
      lines.push(
        multiSelect ? "Answer (separate multiple with commas): " : "Answer: ",
      );

      const answerLine = lines[lines.length - 1] as string;
      process.stdout.write(red("ask_user: "));
      process.stdout.write(lines.slice(0, -1).join("\n") + "\n");
      process.stdout.write(answerLine);

      let settled = false;
      rl.once("line", (line: string) => {
        if (settled) return;
        settled = true;
        rl.close();
        this.mainRl.resume();
        resolve(line.trim());
      });
      rl.once("close", () => {
        if (settled) return;
        settled = true;
        this.mainRl.resume();
        resolve("");
      });
      rl.on("error", () => {
        if (settled) return;
        settled = true;
        rl.close();
        this.mainRl.resume();
        resolve("");
      });
    });
  }
}

/**
 * Creates the handler for the `ask_user` tool. The handler reads the
 * `question` and optional `options` arguments, delegates to the `UserPrompter`
 * to collect the user's answer, and returns it as the tool result string.
 *
 * The `UserPrompter` is passed in at construction time (edge service from
 * `index.ts`), matching the `createToolRunner` extra-handler pattern used by
 * `run_subagent`.
 */
export function makeAskUserHandler(
  prompter: UserPrompter,
): (args: Record<string, unknown>) => Promise<string> {
  return async (args) => {
    const question = args["question"];
    if (typeof question !== "string" || question.trim() === "") {
      return "error: ask_user requires a non-empty 'question' argument";
    }

    const raw = args["options"];
    let options: string[] = [];
    if (Array.isArray(raw)) {
      options = raw.filter((o): o is string => typeof o === "string");
    }

    const multiSelect =
      typeof args["multi_select"] === "boolean" &&
      args["multi_select"] === true;

    const answer = await prompter.ask({ question, options, multiSelect });
    if (answer === "") {
      return "error: ask_user was cancelled (no input received)";
    }
    return `user replied: ${answer}`;
  };
}
