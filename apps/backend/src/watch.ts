import { type FSWatcher, watch } from "node:fs";
import { relative, resolve, sep } from "node:path";

/** A single (debounced) filesystem change, relative to the watched root. */
export interface WatchEvent {
  /** Relative path from the root, forward-slash separated (e.g. "a/b.txt"). */
  path: string;
  /** The raw fs event kind that produced it. */
  event: "change" | "rename";
}

type Listener = (e: WatchEvent) => void;

/** Coalesce bursty fs events per path before emitting, to keep the stream calm. */
const DEBOUNCE_MS = 1000;

/**
 * A dependency-free recursive filesystem watcher. It collapses the many raw
 * `fs` events a single edit produces into one debounced `WatchEvent` per
 * changed path. Uses recursive `fs.watch` where the platform supports it
 * (Windows, macOS) and falls back to a non-recursive root watch otherwise
 * (Linux), so it degrades gracefully rather than throwing.
 */
export function createFileWatcher(rootPath: string) {
  const listeners = new Set<Listener>();
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, WatchEvent>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = (): void => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    for (const e of pending.values()) {
      for (const l of listeners) l(e);
    }
    pending.clear();
  };

  const schedule = (rawPath: string, event: "change" | "rename"): void => {
    const abs = resolve(rootPath, rawPath);
    const rel = relative(rootPath, abs).split(sep).join("/");
    if (!rel || rel.startsWith("..")) return; // ignore anything outside the root
    pending.set(rel, { path: rel, event });
    if (flushTimer === undefined) {
      flushTimer = setTimeout(emit, DEBOUNCE_MS);
    }
  };

  const start = (): void => {
    if (watchers.length > 0) return;
    try {
      const recursive = watch(
        rootPath,
        { recursive: true },
        (event, filename) => schedule(filename ?? rootPath, event)
      );
      recursive.on("error", () => recursive.close());
      watchers.push(recursive);
      return;
    } catch {
      // Recursive watch unavailable on this platform; fall through.
    }
    const root = watch(rootPath, (event, filename) =>
      schedule(filename ?? rootPath, event)
    );
    root.on("error", () => root.close());
    watchers.push(root);
  };

  const close = (): void => {
    for (const w of watchers) w.close();
    watchers.length = 0;
    listeners.clear();
  };

  return {
    start,
    close,
    /** Subscribe to debounced change events; returns an unsubscribe fn. */
    subscribe(l: Listener): () => void {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}
