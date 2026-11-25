import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { describeParseError, parseJson } from "../src/index";

const Person = z.object({ name: z.string() });

describe("parseJson", () => {
  test("reports text that is not JSON as notJson", () => {
    expect(parseJson(Person, "{oops")).toEqual({
      ok: false,
      error: { kind: "notJson" },
    });
  });

  test("reports a wrong shape with the path to the field that failed", () => {
    const parsed = parseJson(Person, '{"name": 3}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatchObject({ kind: "wrongShape", path: "name" });
    }
  });

  test("returns the value for well-formed JSON", () => {
    expect(parseJson(Person, '{"name": "Ana"}')).toEqual({
      ok: true,
      value: { name: "Ana" },
    });
  });
});

describe("describeParseError", () => {
  test("gives user-facing text for each kind of failure", () => {
    expect(describeParseError({ kind: "notJson" })).toBe("not JSON");
    expect(
      describeParseError({
        kind: "wrongShape",
        path: "apiKey",
        message: "bad",
      }),
    ).toBe("apiKey: bad");
    expect(
      describeParseError({ kind: "wrongShape", path: "", message: "bad" }),
    ).toBe("bad");
  });
});
