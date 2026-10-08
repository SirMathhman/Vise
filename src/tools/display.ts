import { tools } from "../tools.ts";
import type { DisplayLookup } from "../output/tool-line.ts";

const byName = new Map(tools.map((t) => [t.function.name, t.display]));

/** The display of a tool by name, from the tool definitions (what the terminal, the web server and history replay show). */
export const displayOfTool: DisplayLookup = (name) => byName.get(name);
