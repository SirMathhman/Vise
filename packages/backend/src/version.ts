/** Stamped into compiled builds by `scripts/build-exe.ts` (`--define`); "dev" when run from source. */
declare const VISE_VERSION: string | undefined;

export const VERSION: string =
  typeof VISE_VERSION === "string" ? VISE_VERSION : "dev";
