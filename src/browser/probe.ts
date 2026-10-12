/**
 * A cheap look at a page for the wait tools: whether some text is on it, and a
 * fingerprint that changes when the page does. Every backend computes it inside
 * the page (`BrowserBackend.pageProbe`, `probeScript` in `page-scripts.ts`), a
 * few bytes per poll.
 */
export interface PageProbe {
  /** Whether the needle is on the page (case- and whitespace-insensitive); false without a needle. */
  contains: boolean;
  /** Equal for two looks at an unchanged page. */
  fingerprint: string;
}
