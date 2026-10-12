/** A llama.cpp slot as `/slots` reports it (only what slot choice needs). */
export interface SlotInfo {
  id: number;
  /** The most recent task the slot ran (grows with time; the highest is the slot used last). */
  id_task?: number;
}

/** Whether every slot reports its task number, without which recency cannot be told. */
function hasTaskNumbers(slots: SlotInfo[]): boolean {
  return slots.every((s) => Number.isInteger(s.id) && typeof s.id_task === "number");
}

/** The slot a call just ran on: the one with the highest task number. Undefined with fewer than two slots or unreadable numbers. */
export function slotJustUsed(slots: SlotInfo[]): number | undefined {
  if (slots.length < 2 || !hasTaskNumbers(slots)) return undefined;
  return [...slots].sort((a, b) => (b.id_task ?? 0) - (a.id_task ?? 0))[0]?.id;
}

/**
 * The slot side work (a subagent) is pinned to: the least recently used one
 * other than the main conversation's. `mainSlot` is the slot the main
 * conversation was last seen on; without it the slot used last is assumed to be
 * the main one. Undefined when there is no other slot to choose.
 */
export function chooseSideSlot(
  slots: SlotInfo[],
  mainSlot: number | undefined,
): number | undefined {
  if (slots.length < 2 || !hasTaskNumbers(slots)) return undefined;
  const main = mainSlot !== undefined && slots.some((s) => s.id === mainSlot)
    ? mainSlot
    : slotJustUsed(slots);
  const others = slots.filter((s) => s.id !== main);
  return others.sort((a, b) => (a.id_task ?? 0) - (b.id_task ?? 0))[0]?.id;
}
