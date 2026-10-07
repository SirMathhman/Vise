import type { Result } from "../core/errors.ts";
import {
  handleHooksCommand,
  hookApplies,
  type HooksView,
  hooksView,
  readBindings,
} from "./hooks-commands.ts";
import type {
  HookSource,
  PostTurnHook,
  PreTurnHook,
  ProfileSource,
} from "./ports.ts";

type AnyHook = PreTurnHook | PostTurnHook;

/**
 * The session's hooks: the live pre/post lists, which of them apply under the
 * active profile, and the `/hooks` command. A hook bound to no profile always
 * runs; a bound hook runs only while one of its profiles is active. Bindings
 * live in the profile files, so they are re-read (`refresh`) before each turn
 * and workflow rather than cached for the whole session.
 */
export class SessionHooks {
  private bindings: Record<string, string[]> = {};

  readonly pre: PreTurnHook[];
  readonly post: PostTurnHook[];
  private readonly source: HookSource | undefined;
  private readonly profiles: ProfileSource | undefined;

  constructor(
    options: {
      preTurnHooks: PreTurnHook[];
      postTurnHooks: PostTurnHook[];
      hookSource?: HookSource;
      profileSource?: ProfileSource;
    },
    private readonly activeProfile: () => string | undefined,
  ) {
    this.pre = options.preTurnHooks;
    this.post = options.postTurnHooks;
    this.source = options.hookSource;
    this.profiles = options.profileSource;
  }

  /** Re-read the profile bindings; call before the hooks of a turn or workflow run. */
  async refresh(): Promise<void> {
    this.bindings = await readBindings(this.profiles);
  }

  /** The hooks of `list` that run under the active profile. */
  applicable<T extends AnyHook>(list: T[]): T[] {
    return list.filter((h) =>
      hookApplies(h.command, this.activeProfile(), this.bindings),
    );
  }

  /** Run the applicable hooks in parallel; returns their non-blank outputs in config order. */
  async run(list: AnyHook[]): Promise<string[]> {
    const outputs = await Promise.all(
      this.applicable(list).map((h) => h.run()),
    );
    return outputs.filter((o) => o.trim() !== "");
  }

  /** `/hooks` and its add / remove / bind / unbind forms. */
  command(line: string): Promise<Result<string>> {
    return handleHooksCommand(line, this.state());
  }

  /** Every hook with the profiles it is bound to, plus the profile names. */
  view(): Promise<HooksView> {
    return hooksView(this.state());
  }

  private state() {
    return {
      pre: this.pre,
      post: this.post,
      source: this.source,
      profiles: this.profiles,
    };
  }
}
