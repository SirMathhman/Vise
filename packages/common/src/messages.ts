/** A message from the page: its `type` and the few fields the routes below read (the rest are read by the handler that owns the type). */
export interface WireMessage {
  type: string;
  /** `inspect_start`: the model call to watch (the running one when absent). */
  request?: number;
  text?: string;
  id?: string;
  name?: string;
  /** `profile_tools` write: the whitelist, or null for all tools. */
  tools?: string[] | null;
  /** `profile_tools`: read the current whitelist instead of writing one. */
  read?: boolean;
  /** `line`: pictures attached to the message (data URIs; checked by `acceptPictures`). */
  images?: unknown;
  /** `line`: the page's id for a message held until the work in flight is done; `unqueue`: the one to remove. */
  qid?: string;
  /** `env_set`: the settings page's values by variable name. */
  values?: Record<string, string>;
}
