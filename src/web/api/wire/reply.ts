/** A message to the page: its `type` and fields. */
export type Reply = Record<string, unknown>;

/** A field of a page message as text; "" when it is anything else. */
export const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A field of a page message as a list of texts; anything that is not one is dropped. */
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

/** What an exception (or a thrown non-error) says, for a reply's `error`. */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The `{ type: "<x>_result", ok: false, error }` reply every editor sends when a save or delete fails. */
export const failedResult = (type: string, error: unknown): Reply[] => [{ type, ok: false, error: errorText(error) }];
