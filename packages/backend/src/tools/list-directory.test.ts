import { describe, expect, test } from "bun:test";
import path from "node:path";
import { renderListing, resolveInside } from "./list-directory";

const files = [
  "README.md",
  "src/index.ts",
  "src/lib/util.ts",
  "src/lib/deep/x.ts",
];

describe("renderListing", () => {
  test("lists only the first level when max depth is 1, directories first", () => {
    expect(renderListing(files, "", 1, 100)).toBe("src/\nREADME.md");
  });

  test("descends the requested number of levels", () => {
    expect(renderListing(files, "", 2, 100)).toBe(
      "src/\n  lib/\n  index.ts\nREADME.md",
    );
  });

  test("cuts the listing to the entry limit and says how many were left out", () => {
    expect(renderListing(files, "", 5, 2)).toBe(
      "src/\n  lib/\n... 5 more entries not shown",
    );
  });

  test("lists a subdirectory and reports missing or file paths", () => {
    expect(renderListing(files, "src/lib", 1, 100)).toBe("deep/\nutil.ts");
    expect(renderListing(files, "nope", 1, 100)).toBe(
      'No directory named "nope" in the project.',
    );
    expect(renderListing(files, "README.md", 1, 100)).toBe(
      '"README.md" is a file, not a directory.',
    );
  });
});

describe("resolveInside", () => {
  const root = path.resolve("project-root");

  test("accepts paths inside the root and normalises them", () => {
    expect(resolveInside(root, "src/lib")).toEqual({
      ok: true,
      value: "src/lib",
    });
    expect(resolveInside(root, ".")).toEqual({ ok: true, value: "" });
  });

  test("refuses paths outside the root", () => {
    expect(resolveInside(root, "../other").ok).toBe(false);
    expect(resolveInside(root, path.resolve("elsewhere")).ok).toBe(false);
  });
});
