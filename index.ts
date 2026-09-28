import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { LlmClient } from "./src/client/llm.ts";
import { tools, toolRunner } from "./src/tools.ts";
import { Session } from "./src/repl/session.ts";
import type { ProfileSource } from "./src/repl/session.ts";
import type { Result } from "./src/core/errors.ts";
import { formatCompactionFailure, formatError } from "./src/output/format.ts";

/**
 * Edge implementation of ProfileSource backed by a `profiles/` directory of
 * `.md` files. This is the sole owner of profile I/O; the session only asks
 * for names and text and performs no fs access itself (invariant #2).
 */
class FileProfileSource implements ProfileSource {
  constructor(private readonly dir: string) {}

  async listProfiles(): Promise<Result<string[]>> {
    if (!existsSync(this.dir)) return { ok: true, value: [] };
    const names = readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
    return { ok: true, value: names };
  }

  async loadProfile(name: string): Promise<Result<string>> {
    const file = join(this.dir, `${name}.md`);
    if (!existsSync(file)) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: `profile '${name}' not found. Run '/profile' to see available profiles.`,
        },
      };
    }
    return { ok: true, value: readFileSync(file, "utf-8") };
  }
}

const client = new LlmClient();
const session = new Session(
  client,
  toolRunner,
  tools,
  client,
  process.cwd(),
  client,
  new FileProfileSource(join(process.cwd(), "profiles")),
);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let chain = Promise.resolve();
rl.on("line", (line) => {
  if (line.trim() === "") return;
  chain = chain.then(async () => {
    const result = await session.handleLine(line);
    if (result === "exit") {
      rl.close();
      return;
    }
    if (result.ok) {
      console.log(result.value);
      if (result.compactionWarning) {
        console.error(formatCompactionFailure(result.compactionWarning));
      }
    } else {
      console.error(formatError(result.error));
    }
  });
});
