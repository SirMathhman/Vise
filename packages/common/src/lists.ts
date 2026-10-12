/**
 * What a frontend's controls show, as data: the profile choices, the tools
 * with their states, the reasoning levels, the saved sessions and whether
 * burst mode is on. A page reads this instead of sending `/profile`, `/tool`,
 * `/reasoning` and `/resume` and parsing the prose answers. A list that could
 * not be read is left out (`errors` says why) and the page keeps what it had.
 */
export interface ListsSnapshot {
  profiles?: { names: string[]; active: string | null };
  tools?: { name: string; enabled: boolean; category?: string }[];
  reasoning?: { levels: readonly string[]; active: string };
  sessions?: { id: string; name: string; updated?: string }[];
  burst: boolean;
  errors: string[];
}
