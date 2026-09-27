import type { Client, Tool } from "../client/llm.ts";
import { runTurn } from "../core/engine.ts";
import type { ToolRunner } from "../core/engine.ts";
import type { Message, Result } from "../core/errors.ts";

/**
 * Owns the conversation state (the growing messages array) and handles
 * per-line turns. Stateless with respect to I/O: it takes the transport
 * types and working directory from the edge and never touches process,
 * stdin, or stdout itself.
 */
export class Session {
  private readonly messages: Message[];
  private readonly client: Client;
  private readonly tools: ToolRunner;
  private readonly toolDefs: Tool[];

  constructor(
    client: Client,
    tools: ToolRunner,
    toolDefs: Tool[],
    cwd: string,
  ) {
    this.client = client;
    this.tools = tools;
    this.toolDefs = toolDefs;
    this.messages = [{ role: "system", content: `Working directory: ${cwd}` }];
  }

  /**
   * Handle a single non-empty line. Returns "exit" when the line is `/exit`;
   * otherwise the Result from the core pipeline.
   */
  async handleLine(line: string): Promise<Result<string> | "exit"> {
    if (line.trim() === "/exit") return "exit";
    this.messages.push({ role: "user", content: line });
    return runTurn(this.client, this.tools, this.messages, this.toolDefs);
  }
}
