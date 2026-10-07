/**
 * A cheap look at a page for the wait tools: whether some text is on it, and a
 * fingerprint that changes when the page does. A backend computes it inside the
 * page (`BrowserBackend.pageProbe`, a few bytes per poll); the functions here do
 * the same from text already read, for a backend that cannot.
 */

export interface PageProbe {
  /** Whether the needle is on the page (case- and whitespace-insensitive); false without a needle. */
  contains: boolean;
  /** Equal for two looks at an unchanged page. */
  fingerprint: string;
}

/** Collapse whitespace and ignore case, so a phrase split across lines or elements still matches. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

function hash(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return h;
}

/** The probe of a page whose visible text is `text`. */
export function textProbe(text: string, needle?: string): PageProbe {
  const page = normalizeText(text);
  return {
    contains: needle !== undefined && page.includes(normalizeText(needle)),
    fingerprint: `${page.length}:${hash(page)}`,
  };
}
