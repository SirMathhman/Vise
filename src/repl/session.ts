import { runTurn } from "../core/engine.ts";
import type { Client, Tool, ToolRunner } from "../core/engine.ts";
import type { Message, Result } from "../core/errors.ts";
import { formatContext } from "../output/format.ts";

/**
 * Source of context-window data. Provided by the edge: the used count comes
 * from the server's own `usage.prompt_tokens` on the last chat call, and the
 * max comes from the server's live `/slots` report. The session only displays
 * it. This is an authoritative server count, not a local estimate.
 */
export interface ContextSource {
  /**
   * The server's token count of the most recent prompt sent (how full the
   * context is after the last turn). `undefined` until the first successful
   * chat returns a usage block.
   */
  lastPromptTokensUsed(): number | undefined;
  /** The model's maximum context window in tokens, queried live. */
  contextMax(): Promise<Result<number>>;
}

/**
 * Owns the conversation state (the growing messages array) and handles
 * per-line turns. Stateless with respect to I/O: it takes the transport
 * types, context source, and working directory from the edge and never
 * touches process, stdin, or stdout itself.
 */
export class Session {
  private readonly messages: Message[];
  private readonly client: Client;
  private readonly tools: ToolRunner;
  private readonly toolDefs: Tool[];
  private readonly context: ContextSource;

  constructor(
    client: Client,
    tools: ToolRunner,
    toolDefs: Tool[],
    context: ContextSource,
    cwd: string,
  ) {
    this.client = client;
    this.tools = tools;
    this.toolDefs = toolDefs;
    this.context = context;
    this.messages = [{ role: "system", content: `Working directory: ${cwd}` }];
  }

  /**
   * Handle a single non-empty line. Returns "exit" when the line is `/exit`;
   * a formatted context line for `/context`; otherwise the Result from the
   * core pipeline.
   */
  async handleLine(line: string): Promise<Result<string> | "exit"> {
    const trimmed = line.trim();
    if (trimmed === "/exit") return "exit";
    if (trimmed === "/context") return this.reportContext();
    this.messages.push({ role: "user", content: line });
    return runTurn(this.client, this.tools, this.messages, this.toolDefs);
  }

  private async reportContext(): Promise<Result<string>> {
    const max = await this.context.contextMax();
    if (!max.ok) return { ok: false, error: max.error };
    const used = this.context.lastPromptTokensUsed() ?? 0;
    return { ok: true, value: formatContext(used, max.value) };
  }
}
