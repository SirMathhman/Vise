import { noAudit, type AuditSink } from "../core/audit.ts";
import type { Result } from "../core/errors.ts";
import {
  type HookCommands,
  type HookPhase,
  handleHooksCommand,
  type HooksView,
  hooksView,
  readProfileHooks,
} from "./hooks-commands.ts";
import type {
  HookSource,
  PostTurnHook,
  PreTurnHook,
  ProfileSource,
} from "./ports.ts";

type AnyHook = PreTurnHook | PostTurnHook;

/**
 * The session's hooks: the live global pre/post lists (they run with every
 * profile), the hooks the active profile owns (they run only while it is
 * active, after the global ones), and the `/hooks` command. A profile's hooks
 * live in its file, so they are re-read (`refresh`) before each turn and
 * workflow rather than cached for the whole session.
 */
export class SessionHooks {
  private profileHooks: Record<string, HookCommands> = {};

  readonly pre: PreTurnHook[];
  readonly post: PostTurnHook[];
  private readonly source: HookSource | undefined;
  private readonly profiles: ProfileSource | undefined;
  private readonly audit: AuditSink;

  constructor(
    options: {
      preTurnHooks: PreTurnHook[];
      postTurnHooks: PostTurnHook[];
      hookSource?: HookSource;
      profileSource?: ProfileSource;
      auditSink?: AuditSink;
    },
    private readonly activeProfile: () => string | undefined,
  ) {
    this.pre = options.preTurnHooks;
    this.post = options.postTurnHooks;
    this.source = options.hookSource;
    this.profiles = options.profileSource;
    this.audit = options.auditSink ?? noAudit;
  }

  /** Re-read the profiles' own hooks; call before the hooks of a turn or workflow run. */
  async refresh(): Promise<void> {
    this.profileHooks = await readProfileHooks(this.profiles);
  }

  /** The hooks of a phase that run now: every global hook, then the active profile's own. */
  applicable(phase: HookPhase): AnyHook[] {
    const global: AnyHook[] = phase === "pre" ? this.pre : this.post;
    const active = this.activeProfile();
    // A command already running globally is not run a second time for the profile.
    const owned = (
      active ? (this.profileHooks[active]?.[phase] ?? []) : []
    ).filter((c) => !global.some((g) => g.command === c));
    const make = this.source?.create.bind(this.source);
    return make ? [...global, ...owned.map((c) => make(c))] : global;
  }

  /** Run a phase's applicable hooks in parallel; returns their non-blank outputs in config order. */
  async run(phase: HookPhase): Promise<string[]> {
    await this.refresh();
    const outputs = await Promise.all(
      this.applicable(phase).map(async (h) => {
        const started = performance.now();
        const output = await h.run();
        this.audit.record({
          kind: "hook_run",
          phase,
          command: h.command,
          ms: performance.now() - started,
          output,
        });
        return output;
      }),
    );
    return outputs.filter((o) => o.trim() !== "");
  }

  /** `/hooks` and its add / remove / `profile <name>` forms. */
  command(line: string): Promise<Result<string>> {
    return handleHooksCommand(line, this.state());
  }

  /** The global hooks and each profile's own hooks, plus the profile names. */
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
