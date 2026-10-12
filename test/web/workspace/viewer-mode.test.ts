import { describe, expect, test } from "bun:test";
import { isSvg, viewerMode } from "../../../packages/frontend/src/workspace/open-tabs.ts";

describe("viewer mode from file name", () => {
  test("svg files render as an image", () => {
    expect(viewerMode("logo.svg")).toBe("svg");
    expect(viewerMode("icon.SVG")).toBe("svg");
    expect(viewerMode("diagram/svg.svg")).toBe("svg");
  });

  test("markdown files render as markdown", () => {
    expect(viewerMode("README.md")).toBe("markdown");
    expect(viewerMode("notes.markdown")).toBe("markdown");
    expect(viewerMode("README.MD")).toBe("markdown");
  });

  test("everything else is plain text", () => {
    expect(viewerMode("app.ts")).toBe("text");
    expect(viewerMode("package.json")).toBe("text");
    expect(viewerMode("file.svgz")).toBe("text");
    expect(viewerMode("README")).toBe("text");
  });

  test("the svg check requires the exact extension", () => {
    expect(isSvg("logo.svg")).toBe(true);
    expect(isSvg("logo.svgz")).toBe(false);
    expect(isSvg("svg")).toBe(false);
  });
});
