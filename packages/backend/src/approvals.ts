import { randomUUID } from "node:crypto";

// A change a tool proposes. The reply waits for the user; apply runs only if they approve it.
export interface Approval {
  title: string;
  body: string;
  apply: () => Promise<string>;
}

// Answers for the replies that are waiting, keyed by approval id.
const waiting = new Map<string, (approved: boolean) => void>();

export interface OpenApproval {
  id: string;
  decided: Promise<boolean>;
  close: () => void;
}

// Registers an approval that a reply is waiting on.
export function openApproval(): OpenApproval {
  const id = randomUUID();
  const decided = new Promise<boolean>((resolve) => {
    waiting.set(id, resolve);
  });
  return {
    id,
    decided,
    close: () => {
      waiting.delete(id);
    },
  };
}

// Records the user's answer. Returns false when no reply is waiting on that id.
export function decideApproval(id: string, approved: boolean): boolean {
  const resolve = waiting.get(id);
  if (resolve === undefined) {
    return false;
  }
  waiting.delete(id);
  resolve(approved);
  return true;
}
