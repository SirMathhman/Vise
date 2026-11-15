import { readFile, realpath, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { err, ok, type Result } from "../../core/messages.ts";
import { resolveInside } from "./contain.ts";

// An edit worked out before the user is asked: the file's text as it is now, and where the first match is.
// applyEdit writes it only while the file still holds that text.
export interface EditPlan {
  // The real location the write goes to, and the path as the model named it.
  realTarget: string;
  rel: string;
  // The real path relative to the working directory, when a link leads somewhere else; undefined otherwise.
  resolvesTo?: string;
  text: string;
  previous: string;
  // Where the first match starts, its line (1-based), and how many matches the file has.
  at: number;
  line: number;
  matches: number;
}

// Finds the first match of `previous` and reads what the edit would do. Nothing is written. A file that
// cannot be read, or text that is not in it, is an error.
export async function planEdit(
  root: string,
  path: string,
  previous: string,
): Promise<Result<EditPlan>> {
  const inside = await resolveInside(root, path);
  if (!inside.ok) return err(inside.error);
  const { realTarget, rel } = inside.value;
  try {
    const text = await readFile(realTarget, "utf8");
    const at = text.indexOf(previous);
    if (at < 0) return err(new Error("previous text was not found"));
    const realRoot = await realpath(root);
    const real = relative(realRoot, realTarget);
    const resolvesTo = real === rel ? undefined : real;
    return ok({
      realTarget,
      rel,
      resolvesTo,
      text,
      previous,
      at,
      line: text.slice(0, at).split("\n").length,
      matches: text.split(previous).length - 1,
    });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// The change shown to the user before they approve it. It says how many matches there are and that only
// the first is replaced, so the question shows what the write will do.
export function editPreview(plan: EditPlan, replacement: string): string {
  const link = plan.resolvesTo === undefined ? "" : ` (resolves to ${plan.resolvesTo})`;
  const count = plan.matches === 1 ? "1 match" : `${plan.matches} matches`;
  return `edit ${plan.rel}${link}\nfound ${count}; the first starts at line ${plan.line}, and only the first is replaced\n--- previous\n${plan.previous}\n+++ replacement\n${replacement}`;
}

// Writes a planned edit. If the file no longer holds the text the plan was made from, nothing is written.
export async function applyEdit(
  plan: EditPlan,
  replacement: string,
): Promise<Result<string>> {
  try {
    const now = await readFile(plan.realTarget, "utf8");
    if (now !== plan.text)
      return err(
        new Error(
          "the file changed after the edit was shown, so nothing was written; read it again",
        ),
      );
    await writeFile(
      plan.realTarget,
      plan.text.slice(0, plan.at) +
        replacement +
        plan.text.slice(plan.at + plan.previous.length),
      "utf8",
    );
    return ok(`edited ${plan.rel}`);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// Replaces the first occurrence of `previous` in an existing file under `root`, with no approval. The
// match is exact, including line endings. The file is never created.
export async function editFile(
  root: string,
  path: string,
  previous: string,
  replacement: string,
): Promise<Result<string>> {
  const plan = await planEdit(root, path, previous);
  if (!plan.ok) return err(plan.error);
  return applyEdit(plan.value, replacement);
}
