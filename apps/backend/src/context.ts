export interface AppContext {
  now: () => Date;
}

export function createContext(): AppContext {
  return { now: () => new Date() };
}
