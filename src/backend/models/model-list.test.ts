import { expect, test } from "bun:test";
import { err, ok, type ModelInfo, type Result } from "../../core/messages.ts";
import type { ServerEvent } from "../../protocol/protocol.ts";
import type { SessionPorts } from "../ports.ts";
import { announceModels, loadModels } from "./model-list.ts";

function portsWith(list: () => Promise<Result<ModelInfo[]>>, current: string): SessionPorts {
  return { models: { current: () => current, list, select: async (name: string) => ok(name) } } as unknown as SessionPorts;
}

test("the models are loaded and announced with the current one; a failed list is reported and is empty", async () => {
  const events: ServerEvent[] = [];
  const emit = (event: ServerEvent) => events.push(event);
  const models: ModelInfo[] = [{ id: "work::anthropic/claude", contextLength: 200000 }];
  const loaded = await loadModels(portsWith(async () => ok(models), "work::anthropic/claude"), emit);
  expect(loaded).toEqual(models);
  announceModels(portsWith(async () => ok(models), "work::anthropic/claude"), emit, loaded);
  expect(events.at(-1)).toEqual({ kind: "models", current: "work::anthropic/claude", models });

  const failed = await loadModels(portsWith(async () => err(new Error("no list")), ""), emit);
  expect(failed).toEqual([]);
  expect(events.at(-1)).toEqual({ kind: "error", message: "could not list the models: no list" });
});
