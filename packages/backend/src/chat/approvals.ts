import { randomUUID } from "node:crypto";

/**
 * A change a tool proposes. The reply waits for the user; apply runs only if they approve it.
 */
export interface Approval {
  title: string;
  body: string;
  apply: () => Promise<string>;
}

/**
 * How long a reply waits for an answer before it gives up on the change.
 */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

// Answers for the replies that are waiting, keyed by approval id.
const waiting = new Map<string, (approved: boolean) => void>();

/**
 * An approval a reply is waiting on: its id, a promise for the user's answer, and a way to release it.
 */
export interface OpenApproval {
  id: string;
  decided: Promise<boolean>;
  close: () => void;
}

/**
 * Registers an approval that a reply is waiting on.
 */
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

/**
 * Records the user's answer. Returns false when no reply is waiting on that id.
 */
export function decideApproval(id: string, approved: boolean): boolean {
  const resolve = waiting.get(id);
  if (resolve === undefined) {
    return false;
  }
  waiting.delete(id);
  resolve(approved);
  return true;
}

/**
 * Waits for the user's answer. Returns undefined when none comes: the client has gone away,
 * or the timeout passes first. The approval is released either way.
 */
export async function waitForApproval(
  pending: OpenApproval,
  signal?: AbortSignal,
  timeoutMs = APPROVAL_TIMEOUT_MS,
): Promise<boolean | undefined> {
  if (signal?.aborted) {
    pending.close();
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs);
  });
  const aborted = new Promise<undefined>((resolve) => {
    signal?.addEventListener(
      "abort",
      () => {
        resolve(undefined);
      },
      { once: true },
    );
  });
  try {
    return await Promise.race([pending.decided, timeout, aborted]);
  } finally {
    clearTimeout(timer);
    pending.close();
  }
}
