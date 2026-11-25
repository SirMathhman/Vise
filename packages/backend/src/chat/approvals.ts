import { randomUUID } from "node:crypto";

/**
 * A change a tool proposes. The reply waits for the user; apply runs only if they approve it.
 */
export interface Approval {
  /** The heading shown on the approval card. */
  title: string;
  /** The text shown on the card, such as a diff. */
  body: string;
  /** Carries out the change once the user approves it. Returns the text the model reads back. */
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
  /** The random id the user's answer is sent to. */
  id: string;
  /** Resolves with the user's answer: true to approve, false to reject. */
  decided: Promise<boolean>;
  /** Releases the approval, so it can no longer be answered. */
  close: () => void;
}

/**
 * Registers an approval that a reply is waiting on.
 *
 * @returns The approval's id, a promise for the user's answer, and a close function.
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
 *
 * @param id The approval id from the card the user sees.
 * @param approved True to approve the change, false to reject it.
 * @returns True when a reply was waiting on that id, false otherwise.
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
 *
 * @param pending The approval to wait on.
 * @param signal Aborts the wait when the client has gone away.
 * @param timeoutMs How long to wait before giving up.
 * @returns The user's answer, or undefined when the wait ended without one.
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
