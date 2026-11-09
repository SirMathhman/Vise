// The page's only side-effecting file: the socket, the reconnect timer, and the render schedule.
// Everything it shows is decided by reduce in state.ts.
import type {
  ApprovalAnswer,
  ClientMessage,
  ServerEvent,
} from "../../protocol/protocol.ts";
import { initialState, reduce, type ViewAction, type ViewState } from "./state.ts";
import { createView } from "./view.ts";

// The close code the server uses when another tab takes over the session.
const TAKEN_OVER = 4001;
const MAX_RETRY_MS = 8000;

const token = new URLSearchParams(location.hash.slice(1)).get("t") ?? "";
const root = document.getElementById("app") as HTMLElement;
let state: ViewState = initialState;
let socket: WebSocket | undefined;
let attempts = 0;
let renderScheduled = false;

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    view.render(state);
  });
}

function dispatch(action: ViewAction): void {
  state = reduce(state, action);
  scheduleRender();
}

// Sends a message if the socket is open. A line sent while it is not is not sent at all.
function send(message: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function parseEvent(text: string): ServerEvent | undefined {
  try {
    return JSON.parse(text) as ServerEvent;
  } catch {
    return undefined;
  }
}

function retryDelay(): number {
  const delay = Math.min(1000 * 2 ** attempts, MAX_RETRY_MS);
  attempts += 1;
  return delay;
}

// Opens a socket. The server replays the whole session on every connection, so the transcript is
// reset first. A session that has ended, or was taken over, is not reconnected.
function connect(): void {
  dispatch({ kind: "reset" });
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${location.host}/ws?t=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.addEventListener("open", () => {
    attempts = 0;
    dispatch({ kind: "link", link: "live" });
  });
  ws.addEventListener("message", (message) => {
    const event = parseEvent(String(message.data));
    if (event !== undefined) dispatch({ kind: "server", event });
  });
  ws.addEventListener("close", (close) => {
    if (socket !== ws) return;
    socket = undefined;
    if (state.ended) return;
    if (close.code === TAKEN_OVER) {
      dispatch({ kind: "link", link: "taken" });
      return;
    }
    dispatch({ kind: "link", link: "lost" });
    setTimeout(connect, retryDelay());
  });
}

const view = createView(document, root, {
  line(text) {
    if (send({ kind: "line", text, shown: state.lastShown })) {
      dispatch({ kind: "sent", text });
    }
  },
  answer(id: number, answer: ApprovalAnswer) {
    send({ kind: "approval", id, answer });
  },
  readProfile(name: string) {
    send({ kind: "profileRead", name });
  },
  writeProfile(profile) {
    send({ kind: "profileWrite", profile });
  },
  answerAsk(id: number, chosen: number[], text: string) {
    send({ kind: "answer", id, chosen, text });
  },
  changeFolder(path: string) {
    send({ kind: "folderChange", path });
  },
  writeMcp(servers) {
    send({ kind: "mcpWrite", servers });
  },
});

if (token === "") {
  dispatch({ kind: "link", link: "no-token" });
} else {
  connect();
}
