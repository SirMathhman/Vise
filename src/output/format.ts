import type { ViseError } from "../core/errors.ts";

/** Render a structured error as a single line for the terminal. */
export function formatError(err: ViseError): string {
  if (err.kind === "http") {
    return `vise: HTTP ${err.status} from server: ${err.body}`;
  } else if (err.kind === "network") {
    return `vise: ${err.cause}`;
  } else {
    return `vise: ${err.body}`;
  }
}
