export interface AppContext {
  now: () => Date;
  rootPath: string;
}

export function createContext(rootPath: string): AppContext {
  return { now: () => new Date(), rootPath };
}
