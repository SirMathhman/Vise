import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { config } from "../config.ts";
import type { McpServerSpec, UrlSpec } from "./mcp-config.ts";

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
const NEWLINE = new RegExp(String.fromCharCode(92) + "r?" + String.fromCharCode(92) + "n");

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
    const spec = this.spec;
    const failure =
      spec.url !== undefined
        ? await this.connectUrl(spec)
        : await this.attempt(() => this.stdioTransport(spec));
    if (failure !== undefined) this.status = { state: "failed", reason: failure };
  }

  private stdioTransport(spec: McpServerSpec): StdioClientTransport {
    const transport = new StdioClientTransport({
      command: spec.command ?? "",
      args: spec.command === undefined ? [] : spec.args,
      env: { ...getDefaultEnvironment(), ...(spec.command === undefined ? {} : spec.env) },
      cwd: this.cwd,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      this.stderr.push(
        ...chunk.toString("utf8").split(NEWLINE).filter(Boolean),
      );
      this.stderr = this.stderr.slice(-STDERR_LINES);
    });
    return transport;
  }

  /** A remote server: Streamable HTTP first, then the older SSE transport if that fails. */
  private async connectUrl(spec: UrlSpec): Promise<string | undefined> {
    const url = new URL(spec.url);
    const requestInit = { headers: spec.headers };
    const streamable = await this.attempt(
      () => new StreamableHTTPClientTransport(url, { requestInit }),
    );
    if (streamable === undefined || this.closed) return undefined;
    const sse = await this.attempt(
      () =>
        new SSEClientTransport(url, {
          requestInit,
          // The event stream is a GET the SDK builds itself, so it needs the headers too.
          eventSourceInit: {
            fetch: (input, init) => {
              const headers = new Headers(init?.headers);
              for (const [k, v] of Object.entries(spec.headers)) headers.set(k, v);
              return fetch(input, { ...init, headers });
            },
          },
        }),
    );
    return sse === undefined ? undefined : `${streamable} (SSE fallback: ${sse})`;
  }

  /** Connect over one transport; resolves to the failure reason, or undefined when connected. */
  private async attempt(make: () => Transport): Promise<string | undefined> {
    const transport = make();
    const client = new Client({ name: "vise", version: "0.1.0" });
    transport.onclose = () => {
      if (this.status.state === "ready" && this.client === client) {
        this.status = { state: "exited", reason: "the connection ended" };
      }
    };
    try {
      await client.connect(transport, { timeout: config.mcpConnectTimeoutMs });
      if (this.closed) {
        // Closed while connecting: the process must not outlive its owner.
        await client.close().catch(() => undefined);
        return undefined;
      }
      this.client = client;
      this.status = { state: "ready" };
      return undefined;
    } catch (err) {
      await client.close().catch(() => undefined);
      return reasonOf(err);
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
