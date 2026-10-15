import { describe, expect, test } from "bun:test";
import type { Message, Picture } from "@vise/core";
import { elideOldImages } from "../../../packages/backend/src/client/tool-protocol.ts";

const pic = (id: string): Picture => ({ id, mime: "image/png", label: id, bytes: 1 });
const shot = (id: string): Message => ({
  role: "tool",
  content: `result ${id}`,
  tool_call_id: id,
  images: [pic(id)],
});
const said = (content = "ok"): Message => ({ role: "assistant", content });

describe("elideOldImages", () => {
  test("the latest round's pictures are sent", () => {
    const messages = [{ role: "user", content: "go" } as Message, said(), shot("a"), shot("b")];
    expect(elideOldImages(messages)).toBe(messages);
  });

  test("a picture is left out of the request after the one that carried it", () => {
    const messages = [said(), shot("a"), said(), shot("b")];
    const out = elideOldImages(messages);
    expect(out[1]?.images).toBeUndefined();
    expect(out[1]?.content).toBe("result a\n[older screenshot omitted]");
    expect(out[3]?.images).toHaveLength(1);
  });

  test("only the tail differs from the request before it", () => {
    // Request N ends with the picture; request N+1 adds a reply and a text result.
    const before = [{ role: "user", content: "go" } as Message, said(), shot("a")];
    const after = [
      ...before,
      said(),
      { role: "tool", content: "text", tool_call_id: "t" } as Message,
    ];
    const sentBefore = elideOldImages(before);
    const sentAfter = elideOldImages(after);
    // Everything but the picture's own message is identical, message for message.
    expect(sentAfter.slice(0, 2)).toEqual(sentBefore.slice(0, 2));
    expect(sentAfter[2]?.content.startsWith(sentBefore[2]!.content)).toBe(true);
  });

  test("does not touch the conversation itself", () => {
    const messages = [said(), shot("a"), said()];
    elideOldImages(messages);
    expect(messages[1]?.images).toHaveLength(1);
    expect(messages[1]?.content).toBe("result a");
  });

  test("never drops pictures the user attached", () => {
    const user: Message = { role: "user", content: "see", images: [pic("u")] };
    const out = elideOldImages([user, said(), shot("a"), said()]);
    expect(out[0]?.images).toHaveLength(1);
    expect(out[2]?.images).toBeUndefined();
  });
});
