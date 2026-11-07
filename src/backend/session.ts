import {
  answerOfLine,
  classifyLine,
  type ApprovalAnswer,
} from "../core/commands.ts";
import {
  profileCommands,
  queueHookOutput,
  type Conversation,
} from "../core/compaction.ts";
import { historyMessages } from "../core/sessions.ts";
import { Channel } from "../protocol/channel.ts";
import type {
  ClientMessage,
  Emit,
  ServerEvent,
  Session,
} from "../protocol/protocol.ts";
import { runCommand } from "./commands/commands.ts";
import type { SessionPorts } from "./ports.ts";
import { runMessageTurn } from "./turn.ts";

// The approval question that is open, if any. Its answer comes as a line or as an approval by id.
interface OpenQuestion {
  id: number;
  resolve(answer: ApprovalAnswer): void;
}

// What a session keeps while it runs. The lines and events are queues: lines wait for the loop,
// and events wait for the frontend.
interface SessionState {
  ports: SessionPorts;
  events: Channel<ServerEvent>;
  lines: Channel<string>;
  question?: OpenQuestion;
  nextId: number;
  // Set when /exit is typed at an approval: the session ends and no further request is sent.
  exitRequested: boolean;
  streamError?: Error;
}

function sink(state: SessionState): Emit {
  return (event) => state.events.push(event);
}

// Once the session has ended for good, nothing else runs: no tool, no request, no approval.
// Queued lines count as input, so the loop goes on until they are taken.
function finished(state: SessionState): boolean {
  return (
    state.exitRequested || state.streamError !== undefined || !state.lines.more
  );
}

// Ends the input: no line will arrive, and an open question is refused.
function endInput(state: SessionState): void {
  state.lines.end();
  state.question?.resolve("refuse");
  state.question = undefined;
}

// Ends the session: the last event says whether it ended with a failure.
function finish(state: SessionState, error?: string): void {
  state.events.push({ kind: "ended", error });
  state.events.end();
}

// Asks the user to approve a change. The lines queued before the question are dropped, so the
// answer must come after it. The answer is the next line typed, or an approval with this id.
async function askApproval(state: SessionState, preview: string): Promise<boolean> {
  if (state.exitRequested || state.streamError !== undefined) return false;
  state.lines.discard();
  const id = state.nextId;
  state.nextId += 1;
  const chosen = new Promise<ApprovalAnswer>((resolve) => {
    state.question = { id, resolve };
  });
  state.events.push({ kind: "approvalRequest", id, preview });
  // Input may have ended before the question, with nothing left to answer it; then it is refused.
  if (!state.lines.more) endInput(state);
  const answer = await chosen;
  state.events.push({ kind: "approvalAnswered", id, answer });
  if (answer === "exit") {
    state.exitRequested = true;
    return false;
  }
  return answer === "approve";
}

// Handles one message from the frontend. While a question is open, a line answers it; an approval
// answers only the question with its id.
function receive(state: SessionState, message: ClientMessage): void {
  switch (message.kind) {
    case "line": {
      const question = state.question;
      if (question === undefined) {
        state.lines.push(message.text);
        return;
      }
      if (message.shown !== undefined && message.shown !== question.id) {
        state.events.push({
          kind: "notice",
          text: "an approval question is open: answer it with its buttons. Your line was not sent.",
        });
        return;
      }
      state.question = undefined;
      question.resolve(answerOfLine(message.text));
      return;
    }
    case "approval": {
      const question = state.question;
      if (question?.id !== message.id) return;
      state.question = undefined;
      question.resolve(message.answer);
      return;
    }
    case "inputEnded":
      endInput(state);
      return;
    case "failed":
      state.streamError ??= new Error(message.message);
      endInput(state);
      return;
  }
}

// Reads lines until /exit, the end of input, or a failure. Each line that is not a message is a
// command; each message is a turn. Returns the conversation the session ended with.
async function sessionLoop(
  state: SessionState,
  start: Conversation,
): Promise<Conversation> {
  const emit = sink(state);
  let conversation = start;
  for (
    let line = await state.lines.next();
    line !== undefined && !state.exitRequested && state.streamError === undefined;
    line = await state.lines.next()
  ) {
    const input = classifyLine(line);
    if (input.kind === "exit") break;
    if (input.kind !== "message") {
      const step = await runCommand(input, state.ports, emit, conversation);
      if (step) {
        conversation = step.conversation;
        if (step.notice) emit({ kind: "notice", text: step.notice });
      }
      await persist(state, conversation);
      emit({ kind: "ready" });
      continue;
    }
    const turn = await runMessageTurn(input.text, conversation, {
      ports: state.ports,
      emit,
      finished: () => finished(state),
      approve: (preview) => askApproval(state, preview),
    });
    conversation = turn.conversation;
    await persist(state, conversation);
    if (turn.stop) break;
    if (state.exitRequested || state.streamError !== undefined) break;
    emit({ kind: "ready" });
  }
  return conversation;
}

// Reads the conversation the last run left behind. A file that cannot be read is reported, and the run
// starts with no conversation.
async function resumedConversation(
  state: SessionState,
): Promise<Conversation | undefined> {
  const store = state.ports.resume;
  if (store === undefined) return undefined;
  const loaded = await store.load();
  if (!loaded.ok) {
    state.events.push({
      kind: "error",
      message: `could not resume the last session: ${loaded.error.message}`,
    });
    return undefined;
  }
  if (loaded.value === undefined) return undefined;
  const shown = historyMessages(loaded.value.history).length;
  if (shown > 0) {
    state.events.push({
      kind: "notice",
      text: `resumed the last session (${shown} messages)`,
    });
  }
  // Only the history and its counts come back. The profile is not restored: its hooks would run at
  // start with no switch and no approval, and its text would be sent again with the next message.
  const { history, compacted, promptTokens } = loaded.value;
  return {
    history,
    compacted,
    promptTokens,
    disabledTools: state.ports.disabledTools,
  };
}

// Saves the conversation so the next run can resume it. A failure is reported, and the session goes on.
async function persist(state: SessionState, conversation: Conversation): Promise<void> {
  const store = state.ports.resume;
  if (store === undefined) return;
  const saved = await store.save(conversation);
  if (!saved.ok) {
    state.events.push({
      kind: "error",
      message: `could not save the session for resuming: ${saved.error.message}`,
    });
  }
}

// The session's whole run: the session-start hooks, the loop, and the session-end hooks. A failure of
// the session-start hooks ends the session before the loop begins.
async function run(state: SessionState): Promise<void> {
  const emit = sink(state);
  const initial: Conversation = (await resumedConversation(state)) ?? {
    history: [],
    compacted: false,
    disabledTools: state.ports.disabledTools,
  };
  if (initial.history.length > 0) {
    emit({ kind: "history", messages: historyMessages(initial.history) });
  }
  const started = await state.ports.hooks(
    "sessionStart",
    profileCommands(initial, "sessionStart"),
  );
  if (!started.ok) return finish(state, started.error.message);
  emit({ kind: "hookOutput", text: started.value });
  const conversation = await sessionLoop(
    state,
    queueHookOutput(initial, started.value),
  );
  const ended = await state.ports.hooks(
    "sessionEnd",
    profileCommands(conversation, "sessionEnd"),
  );
  if (ended.ok) emit({ kind: "hookOutput", text: ended.value });
  else
    emit({
      kind: "error",
      message: `session-end hook failed: ${ended.error.message}`,
    });
  return finish(state, state.streamError?.message);
}

// Starts a session. Its events are queued until the frontend reads them, so the session can run
// while the frontend is still starting.
export function startSession(ports: SessionPorts): Session {
  const state: SessionState = {
    ports,
    events: new Channel<ServerEvent>(),
    lines: new Channel<string>(),
    nextId: 1,
    exitRequested: false,
  };
  void run(state).catch((error: unknown) =>
    finish(state, error instanceof Error ? error.message : String(error)),
  );
  return {
    send: (message) => receive(state, message),
    events: () => state.events,
  };
}
