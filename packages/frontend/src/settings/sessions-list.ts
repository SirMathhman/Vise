import { confirmAction } from "../feedback/confirm.ts";

/** A saved session as the server lists it. */
export interface SavedSession {
  id: string;
  name: string;
  /** When it was last saved, when the listing says. */
  updated?: Date;
}

/**
 * The server's saved sessions as the page keeps them: newest first (those
 * without a time last, in listed order). Pure.
 */
export function newestFirst(
  entries: { id: string; name: string; updated?: string }[],
): SavedSession[] {
  const sessions: SavedSession[] = entries.map((e) => ({
    id: e.id,
    name: e.name,
    ...(e.updated === undefined ? {} : { updated: new Date(e.updated) }),
  }));
  const time = (s: SavedSession): number => s.updated?.getTime() ?? -Infinity;
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((x, y) => time(y.session) - time(x.session) || x.index - y.index)
    .map(({ session }) => session);
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", or the date. Pure. */
export function relativeTime(when: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - when.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return when.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The sessions page's list: one row per saved session (its name and when it
 * was saved) that resumes it, and a × that deletes it after asking. Rows are
 * buttons, so the list works from the keyboard; `filter` narrows it by name.
 */
export function renderSessionList(
  list: HTMLUListElement,
  sessions: SavedSession[],
  filter: string,
  actions: { resume(id: string): void; remove(id: string): void },
): void {
  list.textContent = "";
  const wanted = filter.trim().toLowerCase();
  const shown = sessions.filter((s) => !wanted || s.name.toLowerCase().includes(wanted));
  if (shown.length === 0) {
    const empty = list.appendChild(document.createElement("li"));
    empty.className = "list-empty";
    empty.textContent =
      sessions.length === 0
        ? "No saved sessions yet. Conversations are saved as you go."
        : "No session matches.";
    return;
  }
  const now = new Date();
  for (const session of shown) {
    const item = list.appendChild(document.createElement("li"));
    item.className = "list-row session-row";
    const open = item.appendChild(document.createElement("button"));
    open.type = "button";
    open.className = "session-open";
    open.title = `Resume this session (${session.id})`;
    const name = open.appendChild(document.createElement("span"));
    name.className = "session-name";
    name.textContent = session.name;
    if (session.updated) {
      const when = open.appendChild(document.createElement("span"));
      when.className = "session-when";
      when.textContent = relativeTime(session.updated, now);
    }
    open.addEventListener("click", () => actions.resume(session.id));
    const del = item.appendChild(document.createElement("button"));
    del.type = "button";
    del.className = "btn btn--remove";
    del.textContent = "×";
    del.setAttribute("aria-label", `Delete ${session.name}`);
    del.addEventListener("click", () => {
      void confirmAction({
        title: "Delete this session?",
        message: `“${session.name}” and its conversation are removed. This cannot be undone.`,
      }).then((yes) => {
        if (yes) actions.remove(session.id);
      });
    });
  }
}
