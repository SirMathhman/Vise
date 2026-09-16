import { createFileWatcher } from "./watch.js";

export type FileWatcher = ReturnType<typeof createFileWatcher>;

export interface AppContext {
  now: () => Date;
  rootPath: string;
  /** The app-owned filesystem watcher, started and closed with the app. */
  fileWatcher: FileWatcher;
}

export function createContext(rootPath: string): AppContext {
  const fileWatcher = createFileWatcher(rootPath);
  return { now: () => new Date(), rootPath, fileWatcher };
}
