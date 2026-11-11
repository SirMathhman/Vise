import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type ProviderEntry, type ProviderInput, type ProvidersStore, type Result, type Scope, type ScopeField } from "../core/messages.ts";
import type { LlamaServer } from "./llama-cpp.ts";

// An OpenRouter account: its own key, and no URL, since OpenRouter's is fixed.
export interface OpenRouterAccount {
  kind: "openrouter";
  name: string;
  apiKey: string;
}

// Every provider .vise/providers.json lists.
export type ConfiguredProvider = (OpenRouterAccount | LlamaServer) & ScopeField;

const NameSchema = z.string().min(1).regex(/^[^:]+$/, "a provider name holds no colon");

const ProvidersSchema = z.array(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("openrouter"), name: NameSchema, apiKey: z.string().min(1) }),
    z.object({ kind: z.literal("llama.cpp"), name: NameSchema, url: z.string().min(1), apiKey: z.string().min(1) }),
  ]),
);

// The providers .vise/providers.json lists under the folder. A missing file lists none. The file holds keys, so
// an error never quotes its contents.
export async function readServers(folder: string): Promise<Result<ConfiguredProvider[]>> {
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
  const parsed = ProvidersSchema.safeParse(value);
  if (!parsed.success) {
    return err(new Error(`.vise/providers.json is not in the expected form: ${parsed.error.issues[0]?.message ?? "invalid"}`));
  }
  const names = parsed.data.map((entry) => entry.name);
  if (new Set(names).size !== names.length) return err(new Error(".vise/providers.json names a provider twice"));
  return ok(parsed.data);
}

// Saves run one at a time, so a read-merge-write never overlaps another save.
let queue: Promise<unknown> = Promise.resolve();

// Saves the providers the page sent, replacing the file. A blank key keeps the key saved for a provider of the same
// name; a new provider needs one. An error names the provider, never a key.
export function saveServers(folder: string, inputs: ProviderInput[]): Promise<Result<void>> {
  const run = queue.then(() => saveNow(folder, inputs));
  queue = run.catch(() => undefined);
  return run;
}

async function saveNow(folder: string, inputs: ProviderInput[]): Promise<Result<void>> {
  const existing = await readServers(folder);
  if (!existing.ok) return err(existing.error);
  const saved = new Map(existing.value.map((entry) => [entry.name, entry.apiKey]));
  const entries: ConfiguredProvider[] = [];
  for (const input of inputs) {
    const apiKey = input.apiKey !== "" ? input.apiKey : saved.get(input.name);
    if (apiKey === undefined) return err(new Error(`provider ${input.name} needs a key`));
    entries.push(
      input.kind === "openrouter"
        ? { kind: "openrouter", name: input.name, apiKey }
        : { kind: "llama.cpp", name: input.name, url: input.url, apiKey },
    );
  }
  const parsed = ProvidersSchema.safeParse(entries);
  if (!parsed.success) {
    return err(new Error(`a provider is not in the expected form: ${parsed.error.issues[0]?.message ?? "invalid"}`));
  }
  const names = entries.map((entry) => entry.name);
  if (new Set(names).size !== names.length) return err(new Error("two providers have the same name"));
  try {
    await mkdir(join(folder, ".vise"), { recursive: true });
    const file = join(folder, ".vise", "providers.json");
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch {
    return err(new Error("could not write .vise/providers.json"));
  }
  return ok(undefined);
}

// The store the page uses: the providers without their keys, and saving them.
export function providersStore(folder: string): ProvidersStore {
  return {
    list: async (): Promise<Result<ProviderEntry[]>> => {
      const read = await readServers(folder);
      if (!read.ok) return err(read.error);
      return ok(
        read.value.map((entry) => ({
          kind: entry.kind,
          name: entry.name,
          url: entry.kind === "llama.cpp" ? entry.url : "",
          keySaved: entry.apiKey !== "",
        })),
      );
    },
    save: (inputs) => saveServers(folder, inputs),
  };
}

// Both files: the project folder's, and the home folder's. Each provider is tagged with the file it came from. Both
// lists are kept, so the editor can change either file.
export async function readScopedServers(local: string, global: string): Promise<Result<ConfiguredProvider[]>> {
  const here = await readServers(local);
  if (!here.ok) return err(here.error);
  const there = await readServers(global);
  if (!there.ok) return err(there.error);
  return ok([...here.value.map(tagged("local")), ...there.value.map(tagged("global"))]);
}

function tagged(scope: Scope): (entry: ConfiguredProvider) => ConfiguredProvider {
  return (entry) => ({ ...entry, scope });
}

// The providers that run: a project provider replaces a home provider with the same name.
export function effectiveProviders(servers: ConfiguredProvider[]): ConfiguredProvider[] {
  const local = new Set(servers.filter((entry) => entry.scope === "local").map((entry) => entry.name));
  return servers.filter((entry) => entry.scope !== "global" || !local.has(entry.name));
}

// Scoped saves run one at a time, so the read of both files never overlaps another save.
let scopedQueue: Promise<unknown> = Promise.resolve();

export function saveScopedServers(local: string, global: string, inputs: ProviderInput[]): Promise<Result<void>> {
  const run = scopedQueue.then(() => saveScopedNow(local, global, inputs));
  scopedQueue = run.catch(() => undefined);
  return run;
}

// Every blank key is filled from the file that held a provider of that name, the same file first, before anything is
// written. A check that fails writes nothing. Then the file that gains providers is written before the one that loses
// them, so a provider moved between files keeps its key and is never lost.
async function saveScopedNow(local: string, global: string, inputs: ProviderInput[]): Promise<Result<void>> {
  if (inputs.some((input) => input.scope === undefined)) return err(new Error("a provider has no scope"));
  const here = await readServers(local);
  if (!here.ok) return err(here.error);
  const there = await readServers(global);
  if (!there.ok) return err(there.error);
  const resolved: ProviderInput[] = [];
  for (const input of inputs) {
    const own = input.scope === "global" ? there.value : here.value;
    const other = input.scope === "global" ? here.value : there.value;
    const apiKey = input.apiKey !== "" ? input.apiKey : [...own, ...other].find((entry) => entry.name === input.name)?.apiKey;
    if (apiKey === undefined) return err(new Error(`provider ${input.name} needs a key`));
    resolved.push({ ...input, apiKey });
  }
  const localList = resolved.filter((input) => input.scope === "local");
  const globalList = resolved.filter((input) => input.scope === "global");
  const parts = [
    { root: local, list: localList, stored: here.value },
    { root: global, list: globalList, stored: there.value },
  ];
  const gainsGlobal = globalList.some((input) => !there.value.some((entry) => entry.name === input.name));
  if (gainsGlobal) parts.reverse();
  for (const part of parts) {
    if (part.list.length === 0 && part.stored.length === 0) continue;
    const wrote = await saveNow(part.root, part.list);
    if (!wrote.ok) return err(wrote.error);
  }
  return ok(undefined);
}

// The store for both files, read and saved as one list, with each provider's scope.
export function scopedProvidersStore(local: string, global: string): ProvidersStore {
  return {
    list: async (): Promise<Result<ProviderEntry[]>> => {
      const read = await readScopedServers(local, global);
      if (!read.ok) return err(read.error);
      return ok(
        read.value.map((entry) => ({
          kind: entry.kind,
          name: entry.name,
          url: entry.kind === "llama.cpp" ? entry.url : "",
          keySaved: entry.apiKey !== "",
          scope: entry.scope,
        })),
      );
    },
    save: (inputs) => saveScopedServers(local, global, inputs),
  };
}
