import { describe, expect, test } from "bun:test";
import type { BrowserBackend } from "../../../packages/backend/src/browser/types.ts";
import type { ComboboxState } from "../../../packages/backend/src/browser/combobox.ts";
import {
  chooseInCombobox,
  matchOption,
} from "../../../packages/backend/src/tools/browser/combobox.ts";

const opt = (ref: string, text: string) => ({ ref, text, selected: false });

describe("matchOption", () => {
  const list = [
    opt("e1", "Park Ridge, Illinois, United States"),
    opt("e2", "Park Ridge, New Jersey, United States"),
    opt("e3", "Asian"),
    opt("e4", "Asian Pacific"),
  ];
  test("an exact text wins over a longer one containing it", () => {
    expect(matchOption(list, "asian").option?.ref).toBe("e3");
  });
  test("a part of the text works when it is unique", () => {
    expect(matchOption(list, "new jersey").option?.ref).toBe("e2");
  });
  test("several partial matches are ambiguous, never guessed", () => {
    const found = matchOption(list, "Park Ridge");
    expect(found.option).toBeUndefined();
    expect(found.candidates).toHaveLength(2);
  });
});

/** A control that opens on click, filters on typing and shows what was clicked. */
function fakeCombo(all: string[], opts: { commits?: boolean } = {}) {
  const log: string[] = [];
  let open = false;
  let filter = "";
  let shows = "Select...";
  const visible = () =>
    open ? all.filter((t) => t.toLowerCase().includes(filter.toLowerCase())) : [];
  const state = (): ComboboxState => ({
    control: "e9",
    editable: true,
    open,
    shows,
    options: visible().map((t, i) => opt(`o${i}`, t)),
  });
  const browser = {
    runPageAction: async () => state(),
    click: async (_id: number, ref: string) => {
      log.push(`click ${ref}`);
      if (ref === "e9") open = true;
      else if (opts.commits !== false) {
        shows = visible()[Number(ref.slice(1))] ?? shows;
        open = false;
      } else open = false;
    },
    typeText: async (_id: number, _ref: string, text: string) => {
      log.push(`type ${text}`);
      filter = text;
    },
  } as unknown as BrowserBackend;
  return { browser, log };
}

describe("chooseInCombobox", () => {
  test("opens the list, clicks the option and confirms what the control shows", async () => {
    const { browser, log } = fakeCombo(["Asian", "White", "Black"]);
    expect(await chooseInCombobox(browser, 1, "e9", "Asian")).toBe("Asian");
    expect(log).toEqual(["click e9", "click o0"]);
  });

  test("filters by typing when the option is not listed", async () => {
    const { browser, log } = fakeCombo(["Asian"]);
    // Nothing listed until typed: simulate by wanting text the open list lacks.
    await expect(chooseInCombobox(browser, 1, "e9", "Zebra")).rejects.toThrow(
      /no option matching "Zebra"/,
    );
    expect(log).toContain("type Zebra");
  });

  test("an ambiguous option is an error that names the candidates", async () => {
    const { browser, log } = fakeCombo(["Park Ridge, Illinois", "Park Ridge, New Jersey"]);
    await expect(chooseInCombobox(browser, 1, "e9", "Park Ridge")).rejects.toThrow(
      /matches several options.*Illinois.*New Jersey/,
    );
    expect(log).toEqual(["click e9"]);
  });

  test("a click the control does not reflect is reported as failed", async () => {
    const { browser } = fakeCombo(["Asian"], { commits: false });
    await expect(chooseInCombobox(browser, 1, "e9", "Asian")).rejects.toThrow(
      /but the control shows "Select\.\.\."/,
    );
  });
});
