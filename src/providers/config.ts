import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type Result } from "../core/messages.ts";
import type { LlamaServer } from "./llama-cpp.ts";

const ServersSchema = z.array(
  z.object({
    name: z.string().regex(/^[^/]+$/, "a server name holds no slash"),
    url: z.string().min(1),
    apiKey: z.string().min(1),
  }),
);

// The llama.cpp servers .vise/providers.json lists under the folder. A missing file lists none. The file holds
// keys, so an error never quotes its contents.
export async function readServers(folder: string): Promise<Result<LlamaServer[]>> {
  let text: string;
  try {
    text = await readFile(join(folder, ".vise", "providers.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    return err(new Error("could not read .vise/providers.json"));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(new Error(".vise/providers.json is not valid JSON"));
  }
  const parsed = ServersSchema.safeParse(value);
  if (!parsed.success) {
    return err(new Error(`.vise/providers.json is not in the expected form: ${parsed.error.issues[0]?.message ?? "invalid"}`));
  }
  const names = parsed.data.map((server) => server.name);
  if (new Set(names).size !== names.length) return err(new Error(".vise/providers.json names a server twice"));
  return ok(parsed.data);
}
