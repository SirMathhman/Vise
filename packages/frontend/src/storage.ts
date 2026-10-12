/**
 * This browser's localStorage, which can be missing or throw (a private
 * window, blocked site data): every read answers null and every write is
 * silently dropped, so a page never depends on it.
 */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not kept: the page works without it.
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to remove.
    }
  },
};
