import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config.ts";
import type { McpServerSpec } from "./mcp-config.ts";

/** One tool as an MCP server describes it. */
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** What `callTool` returns that we use. */
export interface McpCallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

export type McpStatus =
  | { state: "connecting" }
  | { state: "ready" }
  | { state: "failed"; reason: string }
  | { state: "exited"; reason: string };

const STDERR_LINES = 8;

const reasonOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Why a server is not usable, for messages. */
export const statusReason = (status: McpStatus): string =>
  "reason" in status ? status.reason : status.state;

/** One MCP server process and the protocol session with it. */
export class McpConnection {
  status: McpStatus = { state: "connecting" };
  private client: Client | undefined;
  private stderr: string[] = [];
  private closed = false;

  constructor(
    readonly name: string,
    readonly spec: McpServerSpec,
    private readonly cwd: string,
  ) {}

  /** The last lines the server wrote to stderr (why it failed, usually). */
  stderrTail(): string {
    return this.stderr.join("\n");
  }

  /** Start the server and complete the handshake; never throws (see `status`). */
  async connect(): Promise<void> {
    this.closed = false;
    this.status = { state: "connecting" };
    this.stderr = [];
    const transport = new StdioClientTransport({
      command: this.spec.command,
      args: this.spec.args,
      env: { ...getDefaultEnvironment(), ...this.spec.env },
      cwd: this.cwd,
      stderr: "pipe",
    });
    const client = new Client({ name: "vise", version: "0.1.0" });
    transport.stderr?.on("data", (chunk: Buffer) => {
      this.stderr.push(
        ...chunk.toString("utf8").split(/\r?\n/).filter(Boolean),
      );
      this.stderr = this.stderr.slice(-STDERR_LINES);
    });
    transport.onclose = () => {
      if (this.status.state === "ready") {
        this.status = { state: "exited", reason: "the server process ended" };
      }
    };
    try {
      await client.connect(transport, { timeout: config.mcpConnectTimeoutMs });
      if (this.closed) {
        // Closed while connecting: the process must not outlive its owner.
        await client.close().catch(() => undefined);
        return;
      }
      this.client = client;
      this.status = { state: "ready" };
    } catch (err) {
      this.status = { state: "failed", reason: reasonOf(err) };
      await client.close().catch(() => undefined);
    }
  }

  /** Every tool the server offers (follows the paging cursor). */
  async listTools(): Promise<McpToolInfo[]> {
    const client = this.client;
    if (!client) return [];
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        out.push({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  /** Call a tool; a failure to reach the server comes back as `error:` text, never a throw. */
  async call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult | string> {
    if (this.status.state !== "ready" || !this.client) {
      return `error: MCP server ${this.name} is not connected (${statusReason(this.status)})`;
    }
    try {
      return (await this.client.callTool(
        { name: tool, arguments: args },
        undefined,
        { signal, timeout: config.mcpToolTimeoutMs },
      )) as McpCallResult;
    } catch (err) {
      return `error: MCP server ${this.name}: ${reasonOf(err)}`;
    }
  }

  /** Mark the server unusable (a failure found after it connected). */
  fail(reason: string): void {
    this.status = { state: "failed", reason };
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    this.status = { state: "exited", reason: "closed" };
    await client?.close().catch(() => undefined);
  }
}
