import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { noFolderRoot } from "./data-dir.ts";
import { TerminalDriver } from "./driver/terminal.ts";
import { StreamDisplay } from "./driver/stream.ts";
import { RlUserPrompter } from "./tools/agent/ask-user.ts";
import { McpHub } from "./mcp/mcp-hub.ts";
import { mcpNote } from "./output/mcp-format.ts";
import { createEdgeSession } from "./wiring.ts";

// Shared prompter for mid-turn user questions: used by the ask_user tool and
// by the max-tool-rounds consent prompt. One RlUserPrompter over the main
// readline so a second prompt can never open a competing interface. It is
// wired directly into the toolRunner (ask_user) and the onMaxRounds callback
// below; the driver owns only the SIGINT/line loop over this same `rl`.
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});
const rlPrompter = new RlUserPrompter(rl);

const display = new StreamDisplay();

// The shared edge stack (client, every data source, the composed ToolRunner,
// and the Session) is built once by the wiring factory so the web frontend
// can reuse the exact same services. The terminal driver supplies the
// terminal-specific display callbacks and prompter; the web driver supplies
// WebSocket-based ones.
// The MCP servers must be up first: their tools are part of the session's fixed tool list.
const noFolder = process.argv.includes("--no-folder");
const mcp = new McpHub(noFolder ? noFolderRoot : process.cwd());
mkdirSync(noFolderRoot, { recursive: true });
await mcp.start();
const mcpProblems = mcpNote(mcp);
if (mcpProblems) console.error(mcpProblems);

const edge = createEdgeSession({
  // `--no-folder`: a session without a working directory (no file or shell tools).
  noFolder,
  mcp,
  onToken: display.onToken,
  onThinking: display.onThinking,
  onPromptProgress: display.onPromptProgress,
  onToolCall: display.onToolCall,
  onToolResult: display.onToolResult,
  onImage: display.onImage,
  onGoal: display.onGoal,
  onWorkflow: display.onWorkflow,
  askUser: rlPrompter,
  onMaxRounds: async (question) => {
    const answer = await rlPrompter.ask({
      question,
      options: ["Continue", "Stop"],
    });
    const a = answer.trim().toLowerCase();
    return a === "1" || a === "continue" || a === "yes" || a === "y";
  },
});

// The interactive frontend: the terminal driver owns the readline line loop,
// Ctrl+C handling, the `> ` prompt marker, and per-turn result rendering. It
// is a thin adapter over the session and the StreamDisplay; swapping it for
// a pipe/script driver (see ARCHITECTURE.md) does not touch the core or the
// session. The driver takes the same `rl` and `rlPrompter` so the ask_user
// handler and the onMaxRounds callback share one prompter instance.
process.once("exit", edge.cleanup);
// A launched browser holds the event loop open, so close it when input ends.
rl.once("close", () => void Promise.all([edge.browser.close(), mcp.close()]));
process.once("SIGINT", () => void mcp.close());

const driver = new TerminalDriver(edge.session, display, rl);
driver.run();
