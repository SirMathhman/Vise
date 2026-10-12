/**
 * Every built-in slash command, once: the terminal's `/help`, the web page's
 * command suggestions and the names a note, profile or workflow may not take
 * all come from this list, so a command added here appears everywhere.
 * Pure data (the web bundle imports it). `test/repl/command-names.test.ts`
 * fails when the session's dispatch table and this catalog disagree.
 */

/** What a command needs from the frontend; the help hides a command whose need is not met. */
export type CommandNeed =
  | "model"
  | "reasoning"
  | "tools"
  | "profile"
  | "notes"
  | "workflows"
  | "sessions"
  | "audit"
  | "mcp"
  | "semantic";

export interface CommandInfo {
  /** With its slash: `/model`. */
  name: string;
  /** One line, shown in the web page's suggestions. */
  summary: string;
  /** The page appends a space after the name when it takes arguments. */
  takesArgs: boolean;
  needs?: CommandNeed;
  /** Answered by the web connection itself (never reaches the session). */
  webOnly?: boolean;
  /** The lines `/help` prints for it, usage forms with their explanation. */
  usage: string[];
}

export const COMMANDS: readonly CommandInfo[] = [
  { name: "/exit", summary: "exit the REPL", takesArgs: false, usage: ["/exit          exit the REPL"] },
  { name: "/help", summary: "show available commands", takesArgs: false, usage: ["/help          show this help"] },
  { name: "/context", summary: "show context window usage", takesArgs: false, usage: ["/context       show context window usage"] },
  { name: "/compact", summary: "compact the conversation", takesArgs: false, usage: ["/compact       compact the conversation now"] },
  {
    name: "/new",
    summary: "start a new conversation",
    takesArgs: false,
    usage: ["/new           start a new conversation (the old one stays saved)"],
  },
  {
    name: "/hooks",
    summary: "list or edit pre/post-turn hooks",
    takesArgs: true,
    usage: [
      "/hooks         show the configured pre/post-turn hook commands",
      '/hooks add pre|post "<command>"  add a hook (saved to .viserc.json)',
      "/hooks remove pre|post <number>  remove a hook",
      "/hooks profile <name> [add|remove pre|post ...]  hooks that run only with a profile",
    ],
  },
  {
    name: "/model",
    summary: "list or switch models",
    takesArgs: true,
    needs: "model",
    usage: ["/model          list available models", "/model <name>   switch to the named model"],
  },
  {
    name: "/reasoning",
    summary: "list or set reasoning effort",
    takesArgs: true,
    needs: "reasoning",
    usage: [
      "/reasoning         list available reasoning efforts",
      "/reasoning <level> set the active reasoning effort",
    ],
  },
  {
    name: "/burst",
    summary: "toggle plan-then-act burst mode",
    takesArgs: true,
    usage: ["/burst [on|off]  think once to plan, then run tool calls without thinking"],
  },
  {
    name: "/goal",
    summary: "show or toggle goal checking (on, off, clear, log)",
    takesArgs: true,
    usage: [
      "/goal [on|off|clear|log [turns]]  check each turn against a goal and keep going until it is met (log: why each turn ended)",
    ],
  },
  {
    name: "/image",
    summary: "attach an image to your next message",
    takesArgs: true,
    usage: ["/image <path>   attach an image file to your next message (clear: /image clear)"],
  },
  {
    name: "/tool",
    summary: "list or toggle tools",
    takesArgs: true,
    needs: "tools",
    usage: [
      "/tool            list available tools",
      "/tool <name|category> enable|disable  enable or disable a tool or a whole category",
    ],
  },
  {
    name: "/mcp",
    summary: "list MCP servers, or restart one",
    takesArgs: true,
    needs: "mcp",
    usage: [
      "/mcp            list MCP servers and their state",
      "/mcp restart <name>  reconnect a server (new tools appear after a page reload or restart)",
    ],
  },
  {
    name: "/profile",
    summary: "list, switch, or create profiles",
    takesArgs: true,
    needs: "profile",
    usage: [
      "/profile        list available profiles",
      "/profile <name>  set the active profile",
      "/profile default  activate the built-in default profile",
      "/profile init <name>  create a new profile with a placeholder body",
      "/profile <name> tools [a,b|all]  show or set a profile's tool whitelist",
    ],
  },
  {
    name: "/note",
    summary: "list notes, or create one: init <name> [category]",
    takesArgs: true,
    needs: "notes",
    usage: [
      "/note            list all notes by scope and category",
      "/note init [--global] <name> [category]  create a new note (project unless --global) with a placeholder body",
    ],
  },
  {
    name: "/workflow",
    summary: "list, run, or create workflows",
    takesArgs: true,
    needs: "workflows",
    usage: [
      "/workflow                 list available workflows",
      "/workflow <name> [input]  run a workflow",
      "/<name> [input]           run the workflow or send the note called <name>",
      "/workflow init <name>    create a project workflow",
      "/workflow init --global <name>  create a global workflow",
    ],
  },
  {
    name: "/save",
    summary: "list or save sessions",
    takesArgs: true,
    needs: "sessions",
    usage: [
      "/save            list saved sessions",
      "/save <name>     save the current conversation under a name",
    ],
  },
  {
    name: "/resume",
    summary: "list or resume sessions",
    takesArgs: true,
    needs: "sessions",
    usage: [
      "/resume          list saved sessions",
      "/resume <name>   resume a previously saved session",
    ],
  },
  {
    name: "/delete",
    summary: "delete a saved session",
    takesArgs: true,
    needs: "sessions",
    usage: ["/delete <name>   delete a saved session"],
  },
  {
    name: "/search",
    summary: "find saved sessions that mention some text",
    takesArgs: true,
    needs: "sessions",
    usage: ["/search <text>   find saved sessions that mention the text"],
  },
  {
    name: "/embed",
    summary: "index files for semantic search: status, rebuild",
    takesArgs: true,
    needs: "semantic",
    usage: [
      "/embed           bring the semantic index up to date (what changed since it was built)",
      "/embed status    what the index holds and whether it is being built",
      "/embed rebuild   embed every file again (after changing VISE_EMBEDDING_MODEL)",
      "/search semantic <text>  find the passages of your files closest in meaning to the text",
    ],
  },
  {
    name: "/audit",
    summary: "what the agent did: tools, models, errors, calls, call <n>",
    takesArgs: true,
    needs: "audit",
    usage: [
      "/audit           what the agent did in this conversation",
      "/audit tools|models|errors|hooks   details",
      "/audit calls [n]       the latest model calls, running ones first",
      "/audit call <n>        one model call: what it wrote, raw, and what repeats",
      "/audit search <text>   search every recorded conversation",
    ],
  },
  {
    name: "/steer",
    summary: "tell the agent now, before its next step",
    takesArgs: true,
    webOnly: true,
    usage: ["/steer <message>  tell the agent now, before its next step"],
  },
  {
    name: "/queue",
    summary: "list held messages, or: clear, remove <number>",
    takesArgs: true,
    webOnly: true,
    usage: ["/queue [clear|remove <number>]  list or edit the messages held until the agent is idle"],
  },
];

/** The names a note, profile or workflow may not take (the commands without their slash). */
export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name.slice(1));

/** The `/help` lines for the commands whose needs are `available` (web-only commands only on the page). */
export function helpLines(available: ReadonlySet<CommandNeed>, web: boolean): string[] {
  return COMMANDS.filter(
    (c) => (c.needs === undefined || available.has(c.needs)) && (web || !c.webOnly),
  ).flatMap((c) => c.usage);
}
