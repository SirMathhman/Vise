import type { BrowserBackend } from "../../browser/types.ts";
import type { ComboboxState } from "../../browser/combobox.ts";

const POLLS = 6;
const POLL_MS = 200;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

type Option = NonNullable<ComboboxState["options"]>[number];

/** The one option `wanted` names: an exact text first, then a part of the text; several partial matches are ambiguous, never guessed. */
export function matchOption(
  options: Option[],
  wanted: string,
): { option?: Option; candidates: Option[] } {
  const w = norm(wanted);
  const exact = options.filter((o) => norm(o.text) === w);
  if (exact.length === 1) return { option: exact[0], candidates: exact };
  const part = exact.length > 0 ? exact : options.filter((o) => norm(o.text).includes(w));
  return { option: part.length === 1 ? part[0] : undefined, candidates: part };
}

async function look(browser: BrowserBackend, id: number, ref: string): Promise<ComboboxState> {
  const state = (await browser.runPageAction(id, { name: "combobox", ref })) as ComboboxState;
  if (state.error === "missing") {
    throw new Error(`unknown element ${ref}: call browser_read for fresh refs`);
  }
  if (state.error === "notcombo") {
    throw new Error(
      `${ref} is neither a <select> nor a drop-down (combobox); use browser_click or browser_type`,
    );
  }
  return state;
}

/** Looks until the popup lists options (it may open or filter asynchronously). */
async function lookForOptions(
  browser: BrowserBackend,
  id: number,
  ref: string,
): Promise<ComboboxState> {
  let state = await look(browser, id, ref);
  for (let i = 0; i < POLLS && !state.options?.length; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    state = await look(browser, id, ref);
  }
  return state;
}

function listOf(options: Option[]): string {
  return (
    options
      .slice(0, 40)
      .map((o) => o.text)
      .join(" | ") + (options.length > 40 ? ` | ... ${options.length - 40} more` : "")
  );
}

/**
 * Chooses `wanted` in the custom drop-down behind `ref`, with the same steps a
 * person takes: open it, filter it by typing when the wanted option is not
 * listed, click the option, and check what the control now shows. An ambiguous
 * or missing option is an error naming the candidates, and a choice the control
 * does not show afterwards is reported as failed, never as done. Answers with
 * the chosen option's text.
 */
export async function chooseInCombobox(
  browser: BrowserBackend,
  id: number,
  ref: string,
  wanted: string,
): Promise<string> {
  let state = await look(browser, id, ref);
  const control = state.control ?? ref;
  if (!state.options?.length) {
    await browser.click(id, control);
    state = await lookForOptions(browser, id, control);
  }
  let found = matchOption(state.options ?? [], wanted);
  if (!found.option && found.candidates.length === 0 && state.editable) {
    await browser.typeText(id, control, wanted, { replace: true });
    state = await lookForOptions(browser, id, control);
    found = matchOption(state.options ?? [], wanted);
  }
  if (!found.option) {
    const pool = found.candidates.length > 0 ? found.candidates : (state.options ?? []);
    const why =
      found.candidates.length > 1
        ? `${JSON.stringify(wanted)} matches several options; name one exactly`
        : `no option matching ${JSON.stringify(wanted)}`;
    throw new Error(`${why} in ${ref}. Options: ${listOf(pool) || "(none listed)"}`);
  }
  await browser.click(id, found.option.ref);
  let after = await look(browser, id, control);
  for (let i = 0; i < POLLS && !norm(after.shows ?? "").includes(norm(found.option.text)); i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    after = await look(browser, id, control);
  }
  if (!norm(after.shows ?? "").includes(norm(found.option.text))) {
    throw new Error(
      `clicked ${JSON.stringify(found.option.text)} in ${ref} but the control shows ${JSON.stringify(after.shows ?? "")}; browser_read to check`,
    );
  }
  return found.option.text;
}
