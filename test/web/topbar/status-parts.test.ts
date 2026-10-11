import { describe, expect, test } from "bun:test";
import { parseChoice, resolveTheme } from "../../../web/src/status/theme-choice.ts";
import { compactCount, parseContextFill } from "../../../web/src/status/context-meter.ts";
import { parseSessionList, relativeTime } from "../../../web/src/settings/sessions-list.ts";

describe("theme", () => {
  test("system follows the operating system; a choice overrides it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("forest", true)).toBe("forest");
    expect(resolveTheme("volcano", true)).toBe("volcano");
    expect(resolveTheme("underwater", false)).toBe("underwater");
  });

  test("anything stored that is not a known theme means system", () => {
    expect(parseChoice("light")).toBe("light");
    expect(parseChoice("dark")).toBe("dark");
    expect(parseChoice("forest")).toBe("forest");
    expect(parseChoice("volcano")).toBe("volcano");
    expect(parseChoice("underwater")).toBe("underwater");
    expect(parseChoice(null)).toBe("system");
    expect(parseChoice("sepia")).toBe("system");
  });
});

describe("context meter", () => {
  test("reads the server's context report", () => {
    expect(parseContextFill("context: 12345 / 141568 tokens (8.72%)")).toEqual({
      used: 12345,
      max: 141568,
      percent: 8.72,
    });
    expect(parseContextFill("context: 0 / 141568 tokens (0%)")?.percent).toBe(0);
    expect(parseContextFill("no numbers here")).toBeUndefined();
  });

  test("counts are shortened", () => {
    expect(compactCount(950)).toBe("950");
    expect(compactCount(1500)).toBe("1.5k");
    expect(compactCount(12345)).toBe("12.3k");
    expect(compactCount(141568)).toBe("141.6k");
    expect(compactCount(2_000_000)).toBe("2M");
  });
});

describe("saved sessions", () => {
  const listing = [
    "saved sessions:",
    "  alpha  (aaaaaaaa-0000-4000-8000-000000000001)  saved 2026-10-01 09:30 UTC",
    "  beta  (bbbbbbbb-0000-4000-8000-000000000002)  saved 2026-10-09 18:05 UTC",
    "  old one  (cccccccc-0000-4000-8000-000000000003)",
    "",
    "/resume <id>  resume a session (an id prefix is enough)",
  ].join("\n");

  test("parses the /resume listing, newest first, sessions without a time last", () => {
    const sessions = parseSessionList(listing);
    expect(sessions.map((s) => s.name)).toEqual(["beta", "alpha", "old one"]);
    expect(sessions[0]?.id).toBe("bbbbbbbb-0000-4000-8000-000000000002");
    expect(sessions[0]?.updated?.toISOString()).toBe("2026-10-09T18:05:00.000Z");
    expect(sessions[2]?.updated).toBeUndefined();
  });

  test("relative times", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    const ago = (minutes: number): Date => new Date(now.getTime() - minutes * 60000);
    expect(relativeTime(ago(0), now)).toBe("just now");
    expect(relativeTime(ago(5), now)).toBe("5 min ago");
    expect(relativeTime(ago(180), now)).toBe("3 h ago");
    expect(relativeTime(ago(26 * 60), now)).toBe("yesterday");
    expect(relativeTime(ago(4 * 24 * 60), now)).toBe("4 days ago");
  });
});
