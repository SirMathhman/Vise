// The command registry: parse a `/` line, dispatch to a handler, return a
// result. No fetch, no stdin/stdout. A command is a pure function of its
// arguments plus the state it is handed; it returns lines to render and,
// optionally, a new active model. It never prints, never reads input, and
// never calls fetch directly (the catalog and persistence hook are passed
// in as parameters).
import type { ModelInfo } from "../llm/types.ts";
import { createProfile, getProfile, listProfiles } from "../profiles.ts";

export type CommandResult = {
  lines: string[];
  isError?: boolean;
  setModel?: string;
  setProfile?: string;
};

export type CommandContext = {
  model: string;
  activeProfile: string;
  listModels: () => Promise<ModelInfo[]>;
  persistModel: (name: string) => void;
};

export async function runCommand(
  text: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const [command, ...rest] = text.split(/\s+/);
  if (command === "/profile") {
    return runProfileCommand(rest, ctx);
  }
  if (command !== "/model") {
    return {
      lines: [`Unknown command: ${command}. Try /model or /profile.`],
      isError: true,
    };
  }
  let models: ModelInfo[];
  try {
    models = await ctx.listModels();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      lines: [`error: could not list models: ${detail}`],
      isError: true,
    };
  }
  const name = rest.join(" ").trim();
  if (name.length === 0) {
    const lines = ["Available models:"];
    for (const m of models) {
      const marks = [
        m.id === ctx.model ? "current" : "",
        m.loaded ? "loaded" : "",
      ];
      const suffix = marks.filter(Boolean).join(", ");
      lines.push(`  ${m.id}${suffix ? ` (${suffix})` : ""}`);
    }
    return { lines };
  }
  if (!models.some((m) => m.id === name)) {
    const lines = [`error: unknown model: ${name}`, "Available models:"];
    for (const m of models) lines.push(`  ${m.id}`);
    return { lines, isError: true };
  }
  try {
    ctx.persistModel(name);
    return { lines: [`model> ${name} (saved to .env.local)`], setModel: name };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { lines: [`model> ${name} (not saved: ${detail})`], setModel: name };
  }
}

// /profile handler. With no argument, lists all available profiles and marks
// the active one. With `new <name>`, creates a profile stub file. With a
// name, switches to that profile by returning setProfile (the loop appends
// a new system message; history is never altered).
function runProfileCommand(rest: string[], ctx: CommandContext): CommandResult {
  if (rest.length === 1 && rest[0] === "new") {
    return {
      lines: ["/profile new requires a name: /profile new <name>"],
      isError: true,
    };
  }
  if (rest.length > 1 && rest[0] === "new") {
    const name = rest.slice(1).join(" ").trim();
    const err = createProfile(name);
    if (err) return { lines: [`error: ${err}`], isError: true };
    return { lines: [`created profile: ${name}`] };
  }
  const name = rest.join(" ").trim();
  if (name.length === 0) {
    const profiles = listProfiles();
    const lines = ["Available profiles:"];
    for (const p of profiles) {
      const mark = p.name === ctx.activeProfile ? " (active)" : "";
      lines.push(`  ${p.name}${mark}`);
    }
    return { lines };
  }
  const profile = getProfile(name);
  if (!profile) {
    const profiles = listProfiles();
    const lines = [`error: unknown profile: ${name}`, "Available profiles:"];
    for (const p of profiles) lines.push(`  ${p.name}`);
    return { lines, isError: true };
  }
  return {
    lines: [`profile> ${profile.name}`],
    setProfile: profile.name,
  };
}
