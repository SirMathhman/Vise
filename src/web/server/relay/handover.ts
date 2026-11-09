import type { Result } from "../../../core/messages.ts";
import type { ClientMessage, Session } from "../../../protocol/protocol.ts";
import type { Hub } from "./hub.ts";

// The session the page talks to, and how it moves to another folder. A folder change ends the session, waits for
// it to finish, and starts the next one; the page stays connected through it.
export interface HandoverOptions {
  session: Session;
  changeFolder?(path: string): Promise<Result<Session>>;
  // Opens the folder dialog on this machine. Undefined when the user cancels.
  pickFolder?(): Promise<Result<string | undefined>>;
}

// running: lines go to the session. ending: the session has been asked to end for a folder change. picking: the
// folder dialog is open. starting: the next session is being made. Input is accepted only while running.
type Phase = "running" | "ending" | "picking" | "starting";

// What the page is told about input that arrives while a folder is being changed.
const CHANGING_NOTICE = "the folder is changing, so this was not sent. Send it again when the change is done.";

export interface Handover {
  // Handles one message from the page.
  forward(message: ClientMessage): void;
  // Runs the sessions in turn, until one ends for good. Resolves then.
  run(): Promise<void>;
}

export function createHandover(options: HandoverOptions, hub: Hub): Handover {
  // The session that lines go to. It is undefined once a folder change has asked it to end.
  let session: Session | undefined = options.session;
  let phase: Phase = "running";
  // The folder asked for, while a change is under way.
  let folder: string | undefined;

  // Asks the session to end, so the next session can start in the folder.
  function requestFolder(path: string): void {
    if (options.changeFolder === undefined || session === undefined) {
      hub.publish({ kind: "error", message: "the folder cannot be changed here" });
      return;
    }
    phase = "ending";
    folder = path;
    session.send({ kind: "inputEnded" });
    session = undefined;
  }

  // Opens the folder dialog. A folder picked is switched to at once, as a typed path would be.
  function pickFolder(): void {
    if (options.pickFolder === undefined) {
      hub.publish({ kind: "error", message: "a folder cannot be picked here" });
      return;
    }
    phase = "picking";
    void options.pickFolder().then((picked) => {
      phase = "running";
      if (!picked.ok) {
        hub.publish({ kind: "error", message: picked.error.message });
      } else if (picked.value !== undefined) {
        requestFolder(picked.value);
      }
    });
  }

  function forward(message: ClientMessage): void {
    if (phase !== "running" || session === undefined) {
      hub.publish({ kind: "notice", text: CHANGING_NOTICE });
      return;
    }
    if (message.kind === "folderChange") return requestFolder(message.path);
    if (message.kind === "pickFolder") return pickFolder();
    session.send(message);
  }

  // Relays the events of one session. The session that ends for a folder change is not reported as ended,
  // though a failure in it is.
  async function relay(current: Session): Promise<"ended" | "switching"> {
    for await (const event of current.events()) {
      if (event.kind === "ended" && phase === "ending") {
        if (event.error !== undefined) hub.publish({ kind: "error", message: event.error });
        return "switching";
      }
      hub.publish(event);
      if (event.kind === "ended") return "ended";
    }
    return "ended";
  }

  async function run(): Promise<void> {
    let current: Session | undefined = session;
    while (current !== undefined) {
      if ((await relay(current)) === "ended" || folder === undefined) return;
      phase = "starting";
      const requested = folder;
      folder = undefined;
      const next = await options.changeFolder?.(requested);
      if (next === undefined) return;
      if (!next.ok) {
        hub.publish({ kind: "error", message: next.error.message });
        hub.publish({ kind: "ended", error: next.error.message });
        return;
      }
      current = next.value;
      session = current;
      phase = "running";
      hub.reset();
      // The page starts its transcript again; the new session then sends its own events.
      hub.publish({ kind: "history", messages: [] });
    }
  }

  return { forward, run };
}
