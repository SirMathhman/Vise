import type { Tool } from "../core/engine.ts";
import type { ToolHandler } from "../tools.ts";
import type { ImageOutbox } from "../tools/images.ts";
import { loadMcpServers, type McpConfig, type McpServerSpec } from "./mcp-config.ts";
import {
  McpConnection,
  statusReason,
  type McpStatus,
} from "./mcp-connection.ts";
import { formatResult, toolName, toVisTool } from "./mcp-tools.ts";

export interface McpServerReport {
  name: string;
  status: McpStatus;
  tools: number;
  stderr: string;
}

/** Whether two specs start the same server (key order does not matter). */
function sameSpec(a: McpServerSpec, b: McpServerSpec): boolean {
  const env = (e: Record<string, string>): string =>
    JSON.stringify(Object.entries(e).sort(([x], [y]) => x.localeCompare(y)));
  return (
    a.command === b.command &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    env(a.env) === env(b.env)
  );
}

/** Every MCP server of one session root: starts them, offers their tools, routes calls. */
export class McpHub {
  private readonly connections = new Map<string, McpConnection>();
  private routes = new Map<string, { server: string; tool: string }>();
  private defs: Tool[] = [];
  private started: Promise<void> | undefined;
  private busy: Promise<void> = Promise.resolve();
  readonly problems: string[];

  constructor(
    private readonly root: string,
    private readonly cfg: McpConfig = loadMcpServers(root),
  ) {
    this.problems = [...cfg.problems];
  }

  /** Connect every server in parallel and collect their tools. Safe to call twice; never rejects. */
  start(): Promise<void> {
    this.started ??= this.apply(this.cfg);
    return this.started;
  }

  /**
   * Bring the running servers in line with `cfg`: stop removed or changed ones,
   * start new or changed ones, leave the rest alone, then collect the tools again.
   * Sessions already built keep the tool list they were given; later ones see this one.
   */
  private async apply(cfg: McpConfig): Promise<void> {
    this.problems.splice(0, this.problems.length, ...cfg.problems);
    const starting: McpConnection[] = [];
    for (const [name, conn] of [...this.connections]) {
      const want = cfg.servers[name];
      if (want && sameSpec(want, conn.spec)) continue;
      this.connections.delete(name);
      void conn.close();
    }
    for (const [name, spec] of Object.entries(cfg.servers)) {
      if (this.connections.has(name)) continue;
      const conn = new McpConnection(name, spec, this.root);
      this.connections.set(name, conn);
      starting.push(conn);
    }
    await Promise.all(starting.map((c) => c.connect()));
    await this.collectTools();
  }

  /** Re-read the configuration files and apply them (see `apply`); calls queue, never overlap. */
  reload(): Promise<void> {
    return this.exclusive(() => this.apply(loadMcpServers(this.root)));
  }

  /** Run a hub-changing operation after the ones before it. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.busy.then(operation);
    this.busy = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async collectTools(): Promise<void> {
    const taken = new Set<string>();
    const defs: Tool[] = [];
    const routes = new Map<string, { server: string; tool: string }>();
    for (const [server, conn] of this.connections) {
      if (conn.status.state !== "ready") continue;
      try {
        for (const info of await conn.listTools()) {
          const name = toolName(server, info.name, taken);
          routes.set(name, { server, tool: info.name });
          defs.push(toVisTool(server, name, info));
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        conn.fail(`tools/list: ${reason}`);
      }
    }
    this.defs = defs;
    this.routes = routes;
  }

  /** The Vise tool definitions; fixed once `start()` has resolved. */
  tools(): Tool[] {
    return this.defs;
  }

  /** Handlers for the tools, writing any pictures to `images`. */
  handlers(images?: ImageOutbox): Record<string, ToolHandler> {
    const out: Record<string, ToolHandler> = {};
    for (const [name, { server, tool }] of this.routes) {
      out[name] = async (args, signal) => {
        const result = await this.connections
          .get(server)
          ?.call(tool, args, signal);
        if (result === undefined) return `error: unknown MCP server ${server}`;
        return typeof result === "string"
          ? result
          : formatResult(result, images);
      };
    }
    return out;
  }

  status(): McpServerReport[] {
    return [...this.connections].map(([name, c]) => ({
      name,
      status: c.status,
      tools: [...this.routes.values()].filter((r) => r.server === name).length,
      stderr: c.stderrTail(),
    }));
  }

  /** Reconnect one server; tools it newly offers apply to the next conversation. */
  restart(name: string): Promise<string> {
    return this.exclusive(() => this.restartNow(name));
  }

  private async restartNow(name: string): Promise<string> {
    const conn = this.connections.get(name);
    if (!conn) return `error: no MCP server named ${name}`;
    await conn.close();
    await conn.connect();
    await this.collectTools();
    return conn.status.state === "ready"
      ? `${name} reconnected`
      : `error: ${name} ${statusReason(conn.status)}`;
  }

  /** Stop every server; waits for a start in progress so no process is left behind. */
  async close(): Promise<void> {
    await this.started?.catch(() => undefined);
    await this.exclusive(async () => undefined);
    await Promise.all([...this.connections.values()].map((c) => c.close()));
  }
}
