import { describe, expect, test } from "bun:test";
import type { Client, Tool, ToolRunner } from "../src/core/engine.ts";
import type { Message, Result } from "../src/core/errors.ts";
import type { ProfileSource } from "../src/repl/session.ts";
import { makeSubagentHandler } from "../src/tools/subagent.ts";

const noopTools: ToolRunner = {
  async run(_name, _args) {
    return "tool output";
  },
};
const noToolDefs: Tool[] = [];

/** A Client that records each conversation it is handed and returns a fixed reply. */
function recordingClient(reply: string): {
  client: Client;
  calls: Message[][];
} {
  const calls: Message[][] = [];
  const client: Client = {
    async chat(messages: Message[], _tools?: Tool[]) {
      // Snapshot: runTurn mutates the messages array in place (documented
      // side channel), so recording the reference would capture the assistant
      // reply that runTurn pushes after chat returns. Record a copy of the
      // conversation as first sent.
      calls.push([...messages]);
      return { ok: true, value: { content: reply } };
    },
  };
  return { client, calls };
}

/** A ProfileSource whose `loadProfile` is supplied per test. */
function stubProfileSource(
  load: (name: string) => Promise<Result<string>>,
): ProfileSource {
  return {
    async listProfiles() {
      return { ok: true, value: [] };
    },
    loadProfile: load,
    async initProfile(name: string) {
      return {
        ok: false,
        error: { kind: "malformed", body: `profile '${name}' not found` },
      };
    },
  };
}

describe("makeSubagentHandler (edge)", () => {
  test("preserves and restores slot cache around the subagent operation", async () => {
    const { client, calls } = recordingClient("done");
    const order: string[] = [];
    const source = stubProfileSource(async () => ({ ok: true, value: "" }));
    const handler = makeSubagentHandler(
      client,
      source,
      "/tmp",
      noopTools,
      noToolDefs,
      undefined,
      undefined,
      undefined,
      async (operation) => {
        order.push("snapshot");
        const result = await operation();
        order.push("restore");
        return result;
      },
    );
    expect(await handler({ task: "do it", profile: "default" })).toBe("done");
    expect(order).toEqual(["snapshot", "restore"]);
    expect(calls).toHaveLength(1);
  });

  test("restores the slot cache when the subagent operation rejects", async () => {
    const client: Client = {
      async chat() {
        throw new Error("subagent crash");
      },
    };
    let restored = false;
    const source = stubProfileSource(async () => ({ ok: true, value: "" }));
    const handler = makeSubagentHandler(
      client,
      source,
      "/tmp",
      noopTools,
      noToolDefs,
      undefined,
      undefined,
      undefined,
      async (operation) => {
        try {
          return await operation();
        } finally {
          restored = true;
        }
      },
    );
    await expect(
      handler({ task: "do it", profile: "default" }),
    ).rejects.toThrow("subagent crash");
    expect(restored).toBeTrue();
  });

  test("returns the subagent's result and passes a fresh conversation to the client", async () => {
    const { client, calls } = recordingClient("done");
    // The "default" profile is a built-in constant, so the ProfileSource is
    // never consulted for it — the conversation is [system, defaultProfile, task].
    const source = stubProfileSource(async () => {
      throw new Error("should not be called for the default profile");
    });
    const handler = makeSubagentHandler(
      client,
      source,
      "/tmp",
      noopTools,
      noToolDefs,
    );
    const result = await handler({ task: "do the thing", profile: "default" });
    expect(result).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({
      role: "system",
      content: "Working directory: /tmp",
    });
    expect(calls[0]?.[2]).toEqual({ role: "user", content: "do the thing" });
  });

  test("loads a named profile via ProfileSource and injects it as a user message", async () => {
    const { client, calls } = recordingClient("ok");
    const source = stubProfileSource(async (name) => {
      expect(name).toBe("specialist");
      return { ok: true, value: "You are a specialist." };
    });
    const handler = makeSubagentHandler(
      client,
      source,
      "/tmp",
      noopTools,
      noToolDefs,
    );
    const result = await handler({
      task: "do the thing",
      profile: "specialist",
    });
    expect(result).toBe("ok");
    expect(calls[0]).toEqual([
      { role: "system", content: "Working directory: /tmp" },
      { role: "user", content: "You are a specialist." },
      { role: "user", content: "do the thing" },
    ]);
  });

  test("returns an error string when the task is missing or empty", async () => {
    const { client } = recordingClient("x");
    const source = stubProfileSource(async () => {
      return { ok: true, value: "p" };
    });
    const handler = makeSubagentHandler(
      client,
      source,
      "/tmp",
      noopTools,
      noToolDefs,
    );
    expect(await handler({ profile: "default" })).toBe(
      "error: run_subagent requires a non-empty 'task' argument",
    );
    expect(await handler({ task: "   ", profile: "default" })).toBe(
      "error: run_subagent requires a non-empty 'task' argument",
    );
  });

  test("returns an error string when the profile is missing", async () => {
    const { client } = recordingClient("x");
    const source = stubProfileSource(async () => {
      return { ok: true, value: "p" };
    });
    const handler = makeSubagentHandler(
      client,
      source,
      "/tmp",
      noopTools,
      noToolDefs,
    );
    expect(await handler({ task: "do it" })).toBe(
      "error: run_subagent requires a 'profile' argument",
    );
  });

  test("propagates a ProfileSource load error as an error string", async () => {
    const { client, calls } = recordingClient("x");
    const source = stubProfileSource(async () => {
      return {
        ok: false,
        error: { kind: "malformed", body: "profile 'nope' not found." },
      };
    });
    const handler = makeSubagentHandler(
      client,
      source,
      "/tmp",
      noopTools,
      noToolDefs,
    );
    const result = await handler({ task: "do it", profile: "nope" });
    expect(result).toBe("error: vise: profile 'nope' not found.");
    // The client is never consulted when the profile fails to load.
    expect(calls).toHaveLength(0);
  });

  test("propagates a client error as an error string", async () => {
    const client: Client = {
      async chat(_m: Message[], _t?: Tool[]) {
        return { ok: false, error: { kind: "network", cause: "boom" } };
      },
    };
    const source = stubProfileSource(async () => {
      return { ok: true, value: "" };
    });
    const handler = makeSubagentHandler(
      client,
      source,
      "/tmp",
      noopTools,
      noToolDefs,
    );
    expect(await handler({ task: "do it", profile: "default" })).toBe(
      "error: vise: boom",
    );
  });

  test("indents the subagent's streamed tokens at the start of each line", async () => {
    // Disable color so this test isolates indentation from ANSI wrapping.
    const savedNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const received: string[] = [];
    // A client that streams its reply through onToken, then returns it as
    // content. runTurn forwards the handler's indentedOnToken to chat as the
    // onToken callback, so the captured tokens are what the driver's onToken
    // sees.
    const client: Client = {
      async chat(
        _m: Message[],
        _t?: Tool[],
        onToken?: (token: string) => void,
      ) {
        // Two tokens: one ends in a newline, one does not. This exercises both
        // the indentation and the line-start tracking.
        onToken?.("hello\n");
        onToken?.("world");
        return { ok: true, value: { content: "hello\nworld" } };
      },
    };
    const source = stubProfileSource(async () => ({ ok: true, value: "" }));
    const handler = makeSubagentHandler(
      client,
      source,
      "/tmp",
      noopTools,
      noToolDefs,
      (token: string) => {
        received.push(token);
      },
    );
    await handler({ task: "do it", profile: "default" });
    // Both line starts are indented by two spaces.
    expect(received).toEqual(["  hello\n", "  world"]);
    if (savedNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = savedNoColor;
    }
  });

  test("dims the subagent's streamed tokens when color is enabled", async () => {
    // Force color on so `dim` emits codes. `isEnabled()` reads `process.env`
    // per call, so mutating it here (with restore) deterministically enables
    // color for the duration of this test only.
    const savedForce = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const received: string[] = [];
      const client: Client = {
        async chat(
          _m: Message[],
          _t?: Tool[],
          onToken?: (token: string) => void,
        ) {
          // Two tokens: one ends in a newline, one does not. The dim codes
          // wrap each whole token (indent + content), so each captured token
          // is a self-contained dimmed span.
          onToken?.("hello\n");
          onToken?.("world");
          return { ok: true, value: { content: "hello\nworld" } };
        },
      };
      const source = stubProfileSource(async () => ({ ok: true, value: "" }));
      const handler = makeSubagentHandler(
        client,
        source,
        "/tmp",
        noopTools,
        noToolDefs,
        (token: string) => {
          received.push(token);
        },
      );
      await handler({ task: "do it", profile: "default" });
      // With color forced on, each line-start token is indented then dimmed.
      expect(received).toEqual([
        "\x1b[2m  hello\n\x1b[0m",
        "\x1b[2m  world\x1b[0m",
      ]);
    } finally {
      if (savedForce === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = savedForce;
    }
  });
});
