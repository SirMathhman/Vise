import { describe, expect, test } from "bun:test";
import { newestFirst, relativeTime } from "../../../web/src/settings/sessions-list.ts";

describe("saved sessions", () => {
  const entries = [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "alpha", updated: "2026-10-01T09:30:00.000Z" },
    { id: "bbbbbbbb-0000-4000-8000-000000000002", name: "beta", updated: "2026-10-09T18:05:00.000Z" },
    { id: "cccccccc-0000-4000-8000-000000000003", name: "old one" },
  ];

  test("lists newest first, sessions without a time last", () => {
    const sessions = newestFirst(entries);
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
