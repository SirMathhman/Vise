/**
 * Who has a saved session open. A saved session belongs to at most one
 * connection at a time: two tabs (or a tab and the Firefox sidebar) on the same
 * folder that both continued it would write to the same file and overwrite each
 * other's saves. So a connection takes a lease on the session it is working in;
 * the automatic restore and an explicit `/resume` leave a session another
 * connection holds alone.
 */

const held = new Map<string, object>();

const key = (root: string, id: string): string => `${root}\0${id}`;

/** One connection's claim on the sessions of its folder. */
export class SessionLease {
  constructor(private readonly root: string) {}

  /** Take the lease on a session; false when another connection holds it. */
  claim(id: string): boolean {
    const owner = held.get(key(this.root, id));
    if (owner !== undefined && owner !== this) return false;
    held.set(key(this.root, id), this);
    return true;
  }

  /** Whether another connection holds this session. */
  heldByOther(id: string): boolean {
    const owner = held.get(key(this.root, id));
    return owner !== undefined && owner !== this;
  }

  /** This connection works in exactly `id` now (or in none): drop its other leases, take that one if it is free. */
  follow(id: string | undefined): void {
    this.release(id);
    if (id !== undefined) this.claim(id);
  }

  /** Drop every lease this connection holds (except `keep`). */
  release(keep?: string): void {
    for (const [k, owner] of held) {
      if (owner === this && k !== (keep && key(this.root, keep)))
        held.delete(k);
    }
  }
}
