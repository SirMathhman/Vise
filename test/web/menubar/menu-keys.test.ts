import { describe, expect, test } from "bun:test";
import { menuKey, neighbourMenu } from "../../../packages/frontend/src/menubar/menu-keys.ts";

const items = [
  { label: "New conversation", enabled: true },
  { label: "Save as…", enabled: false },
  { label: "Settings", enabled: true },
  { label: "Search", enabled: true },
];

describe("menuKey", () => {
  test("arrows move through the enabled items and wrap", () => {
    expect(menuKey("ArrowDown", items, 0)).toEqual({ kind: "move", index: 2 });
    expect(menuKey("ArrowDown", items, 3)).toEqual({ kind: "move", index: 0 });
    expect(menuKey("ArrowUp", items, 0)).toEqual({ kind: "move", index: 3 });
    expect(menuKey("ArrowUp", items, 2)).toEqual({ kind: "move", index: 0 });
  });

  test("Home and End jump to the first and last enabled item", () => {
    const ends = [{ label: "a", enabled: false }, ...items, { label: "z", enabled: false }];
    expect(menuKey("Home", ends, 3)).toEqual({ kind: "move", index: 1 });
    expect(menuKey("End", ends, 1)).toEqual({ kind: "move", index: 4 });
  });

  test("a letter jumps to the next enabled item starting with it, cycling", () => {
    expect(menuKey("s", items, 0)).toEqual({ kind: "move", index: 2 });
    expect(menuKey("s", items, 2)).toEqual({ kind: "move", index: 3 });
    expect(menuKey("S", items, 3)).toEqual({ kind: "move", index: 2 });
    expect(menuKey("x", items, 0)).toEqual({ kind: "none" });
  });

  test("Enter and Space choose only an enabled item", () => {
    expect(menuKey("Enter", items, 0)).toEqual({ kind: "activate" });
    expect(menuKey(" ", items, 2)).toEqual({ kind: "activate" });
    expect(menuKey("Enter", items, 1)).toEqual({ kind: "none" });
    expect(menuKey("Enter", items, -1)).toEqual({ kind: "none" });
  });

  test("Escape and Tab close; Left and Right switch menus", () => {
    expect(menuKey("Escape", items, 0)).toEqual({ kind: "close" });
    expect(menuKey("Tab", items, 0)).toEqual({ kind: "close" });
    expect(menuKey("ArrowLeft", items, 0)).toEqual({ kind: "switch", direction: -1 });
    expect(menuKey("ArrowRight", items, 0)).toEqual({ kind: "switch", direction: 1 });
  });

  test("an empty menu only closes", () => {
    expect(menuKey("ArrowDown", [], -1)).toEqual({ kind: "none" });
    expect(menuKey("Escape", [], -1)).toEqual({ kind: "close" });
  });
});

test("neighbourMenu wraps around the bar", () => {
  expect(neighbourMenu(0, -1, 3)).toBe(2);
  expect(neighbourMenu(2, 1, 3)).toBe(0);
  expect(neighbourMenu(1, 1, 3)).toBe(2);
});
