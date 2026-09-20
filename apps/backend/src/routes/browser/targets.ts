import type { Page } from "playwright-core";
import { badRequest } from "../../errors.js";
import { collectTargets, type Target } from "./snapshot.js";

/**
 * The single element-number validator shared by every element-targeting tool.
 * Reads each named numeric argument (`n` for click/type, `from`/`to` for drag),
 * collects the page's current elements once, and range-checks every number
 * against that same capped list — so the model can only target an element the
 * snapshot showed it. Returns one Target per key, in `keys` order, or throws a
 * model-readable badRequest.
 */
export async function resolveTargets(
  page: Page,
  args: Record<string, unknown>,
  keys: string[]
): Promise<Target[]> {
  const numbers = keys.map((k) => {
    const v = args[k];
    return typeof v === "number" ? Math.trunc(v) : Number.NaN;
  });
  if (numbers.some((n) => !Number.isFinite(n))) {
    const plural = keys.length > 1;
    throw badRequest(
      `${keys.join(" and ")} ${plural ? "are" : "is"} required (${plural ? "element numbers" : "an element number"})`
    );
  }
  const targets = await collectTargets(page);
  return numbers.map((n) => {
    const target = targets[n];
    if (!target) {
      throw badRequest(
        `no element ${n}; the page has ${targets.length} interactive elements (0..${targets.length - 1})`
      );
    }
    return target;
  });
}
