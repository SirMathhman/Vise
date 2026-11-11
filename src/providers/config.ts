import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type ProviderEntry, type ProviderInput, type ProvidersStore, type Result } from "../core/messages.ts";
import type { LlamaServer } from "./llama-cpp.ts";

const ServersSchema = z.array(
  z.object({
    name: z.string().regex(/^[^:]+$/, "a server name holds no colon"),
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

// Saves the servers the page sent, replacing the file. A blank key keeps the key saved for a server of the same
// name; a new server needs one. An error names the server, never a key.
// Saves run one at a time, so a read-merge-write never overlaps another save.
let queue: Promise<unknown> = Promise.resolve();

export function saveServers(folder: string, inputs: ProviderInput[]): Promise<Result<void>> {
  const run = queue.then(() => saveNow(folder, inputs));
  queue = run.catch(() => undefined);
  return run;
}

async function saveNow(folder: string, inputs: ProviderInput[]): Promise<Result<void>> {
  const existing = await readServers(folder);
  if (!existing.ok) return err(existing.error);
  const saved = new Map(existing.value.map((server) => [server.name, server.apiKey]));
  const servers: LlamaServer[] = [];
  for (const input of inputs) {
    const apiKey = input.apiKey !== "" ? input.apiKey : saved.get(input.name);
    if (apiKey === undefined) return err(new Error(`server ${input.name} needs a key`));
    servers.push({ name: input.name, url: input.url, apiKey });
  }
  const parsed = ServersSchema.safeParse(servers);
  if (!parsed.success) {
    return err(new Error(`a server is not in the expected form: ${parsed.error.issues[0]?.message ?? "invalid"}`));
  }
  const names = servers.map((server) => server.name);
  if (new Set(names).size !== names.length) return err(new Error("two servers have the same name"));
  try {
    await mkdir(join(folder, ".vise"), { recursive: true });
    const file = join(folder, ".vise", "providers.json");
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(servers, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch {
    return err(new Error("could not write .vise/providers.json"));
  }
  return ok(undefined);
}

// The store the page uses: the servers without their keys, and saving them.
export function providersStore(folder: string): ProvidersStore {
  return {
    list: async (): Promise<Result<ProviderEntry[]>> => {
      const read = await readServers(folder);
      if (!read.ok) return err(read.error);
      return ok(read.value.map((server) => ({ name: server.name, url: server.url, keySaved: server.apiKey !== "" })));
    },
    save: (servers) => saveServers(folder, servers),
  };
}
