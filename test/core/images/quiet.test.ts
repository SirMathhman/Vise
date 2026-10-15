import { describe, expect, test } from "bun:test";
import { runTurn } from "@vise/core";
import type { AssistantMessage, Client, Message, Picture, ToolRunner } from "@vise/core";

const picture = (id: string, quiet: boolean): Picture => ({
  id,
  mime: "image/png",
  label: id,
  bytes: 1,
  ...(quiet ? { quiet: true } : {}),
});

/** A model that calls one tool, then answers. */
function client(): Client {
  let n = 0;
  return {
    chat: async () => {
      const reply: AssistantMessage =
        n++ === 0
          ? {
              content: "",
              tool_calls: [
                { type: "function", id: "c1", function: { name: "t", arguments: "{}" } },
              ],
            }
          : { content: "done" };
      return { ok: true, value: reply };
    },
  };
}

describe("quiet pictures", () => {
  test("go to the model with the tool result but are not shown", async () => {
    const shown: string[] = [];
    const tools: ToolRunner = {
      run: async () => "ok",
      takeImages: () => [picture("seen", false), picture("quiet", true)],
    };
    const messages: Message[] = [{ role: "user", content: "go" }];
    const result = await runTurn(client(), tools, messages, [], {
      onImage: (image) => shown.push(image.id),
    });
    expect(result.ok).toBe(true);
    expect(shown).toEqual(["seen"]);
    const toolMessage = messages.find((m) => m.role === "tool");
    expect(toolMessage?.images?.map((i) => i.id)).toEqual(["seen", "quiet"]);
  });
});
