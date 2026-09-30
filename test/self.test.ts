import { describe, expect, test } from "bun:test";
import { makeSelfHandler, type SelfInfo } from "../src/tools/self.ts";

/** A SelfInfo with fixed state, used to assert the handler renders each field. */
function makeInfo(overrides: Partial<SelfInfo> = {}): SelfInfo {
  return {
    backend: "llama.cpp",
    model: () => "model-a",
    cwd: "/tmp",
    contextMax: async () => ({ ok: true as const, value: 1000 }),
    lastPromptTokens: () => 100,
    activeProfile: () => "coder",
    preTurnHooks: ["date"],
    postTurnHooks: [],
    ...overrides,
  };
}

describe("makeSelfHandler (edge)", () => {
  test("reports backend, model, cwd, context fill, profile, and hooks", async () => {
    const handler = makeSelfHandler(makeInfo());
    const result = await handler({});
    expect(result).toBe(
      [
        "self:",
        "  backend: llama.cpp",
        "  model: model-a",
        "  working directory: /tmp",
        "  context: 100 / 1000 tokens (10.0%)",
        "  active profile: coder",
        "  pre-turn hooks:\n    date",
        "  post-turn hooks: none",
      ].join("\n"),
    );
  });

  test("renders 'none' for the active profile when unset", async () => {
    const handler = makeSelfHandler(
      makeInfo({ activeProfile: () => undefined }),
    );
    const result = await handler({});
    expect(result).toContain("active profile: none");
  });

  test("renders one line per hook command", async () => {
    const handler = makeSelfHandler(
      makeInfo({
        preTurnHooks: ["a", "b"],
        postTurnHooks: ["c"],
      }),
    );
    const result = await handler({});
    expect(result).toContain("pre-turn hooks:\n    a\n    b");
    expect(result).toContain("post-turn hooks:\n    c");
  });

  test("surfaces a contextMax failure as 'context: unknown'", async () => {
    const handler = makeSelfHandler(
      makeInfo({
        contextMax: async () => ({
          ok: false as const,
          error: { kind: "network", cause: "boom" },
        }),
      }),
    );
    const result = await handler({});
    expect(result).toContain("context: unknown (vise: boom)");
  });

  test("ignores arguments (self takes none)", async () => {
    const handler = makeSelfHandler(makeInfo());
    const a = await handler({});
    const b = await handler({ ignored: "x" });
    expect(a).toBe(b);
  });
});
