import { describe, expect, test } from "bun:test";
import { parseStatus } from "../../../apps/web/src/api/git-api.ts";

const z = (...entries: string[]): string => entries.join("\0") + "\0";

describe("parseStatus (git status --porcelain=v1 --branch -z)", () => {
  test("branch, upstream counts, and files by state", () => {
    const status = parseStatus(
      z(
        "## main...origin/main [ahead 2, behind 1]",
        "M  staged.ts",
        " M changed.ts",
        "MM both.ts",
        "A  added.ts",
        " D gone.ts",
        "?? new.ts",
      ),
    );
    expect(status.branch).toBe("main");
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.staged).toEqual([
      { path: "staged.ts", code: "M" },
      { path: "both.ts", code: "M" },
      { path: "added.ts", code: "A" },
    ]);
    expect(status.changed).toEqual([
      { path: "changed.ts", code: "M" },
      { path: "both.ts", code: "M" },
      { path: "gone.ts", code: "D" },
    ]);
    expect(status.untracked).toEqual([{ path: "new.ts", code: "?" }]);
  });

  test("a rename's old path is not taken for a file of its own", () => {
    const status = parseStatus(z("## main", "R  new name.ts", "old name.ts", " M other.ts"));
    expect(status.staged).toEqual([{ path: "new name.ts", code: "R" }]);
    expect(status.changed).toEqual([{ path: "other.ts", code: "M" }]);
  });

  test("conflicts are listed once, as U", () => {
    const status = parseStatus(z("## main", "UU clash.ts", "AA both-added.ts"));
    expect(status.staged).toEqual([]);
    expect(status.changed).toEqual([
      { path: "clash.ts", code: "U" },
      { path: "both-added.ts", code: "U" },
    ]);
  });

  test("a repository with no commits, and one without an upstream", () => {
    expect(parseStatus(z("## No commits yet on trunk")).branch).toBe("trunk");
    const plain = parseStatus(z("## feature/x"));
    expect(plain.branch).toBe("feature/x");
    expect(plain.ahead).toBeUndefined();
  });
});
