import { expect, test } from "bun:test";
import { handleModelMessage } from "../../../src/web/api/models/model-api.ts";


function ports(
  models: { ok: boolean; value?: unknown; error?: unknown },
  switched: string[] = [],
  known: string[] = ["a/one", "b/two"],
) {
  let active = "a/one";
  return {
    switched,
    details: async () => models as never,
    controller: {
      listModels: async () => ({ ok: true as const, value: known }),
      getModel: () => active,
      setModel: (name: string) => {
        switched.push(name);
        active = name;
      },
    },
  };
}

test("model_list answers with the provider's models and the active one", async () => {
  const list = [{ id: "a/one", name: "One", vision: false, contextLength: 8000 }];
  const reply = await handleModelMessage(ports({ ok: true, value: list }), { type: "model_list" });
  expect(reply).toEqual({ type: "model_list", models: list, active: "a/one" });
});

test("model_set refuses an unknown local model and a missing id, naming the model still active", async () => {
  const switched: string[] = [];
  const p = ports({ ok: true, value: [] }, switched);
  const unknown = await handleModelMessage(p, { type: "model_set", model: "nope" });
  expect(unknown.ok).toBe(false);
  expect(String(unknown.error)).toContain("unknown model 'nope'");
  expect(unknown.active).toBe("a/one");
  const missing = await handleModelMessage(p, { type: "model_set" });
  expect(missing.ok).toBe(false);
  expect(switched).toEqual([]);
});

test("model_list reports a failed fetch as an error, not an empty list", async () => {
  const failed = { ok: false, error: { kind: "network", cause: "offline" } };
  const reply = await handleModelMessage(ports(failed), { type: "model_list" });
  expect(reply.type).toBe("model_list");
  expect(reply.models).toBeUndefined();
  expect(String(reply.error)).toContain("offline");
  expect(reply.active).toBe("a/one");
});

test("model_set goes through the /model controller, which re-checks the vision tools", async () => {
  const switched: string[] = [];
  const reply = await handleModelMessage(ports({ ok: true, value: [] }, switched), { type: "model_set", model: "b/two" });
  expect(switched).toEqual(["b/two"]);
  expect(reply).toEqual({ type: "model_set", ok: true, active: "b/two" });
});
