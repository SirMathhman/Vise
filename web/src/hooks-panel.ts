/** Id the `/hooks` request carries, so its reply is told apart from the model's turns. */
const REQUEST_ID = "hooks";

interface HooksReply {
  id?: string;
  ok?: boolean;
  value?: string;
  error?: string;
}

/**
 * The read-only hooks panel: lists the pre- and post-turn hook commands
 * configured in `.viserc.json` (the server's `/hooks` command). Opening the
 * panel re-reads them, so it always reflects the running server.
 */
export function createHooksPanel(
  button: HTMLButtonElement,
  panel: HTMLElement,
  text: HTMLElement,
  request: (id: string) => void,
): { handle(message: HooksReply): boolean } {
  button.addEventListener("click", () => {
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) request(REQUEST_ID);
  });
  return {
    handle(message) {
      if (message.id !== REQUEST_ID) return false;
      text.textContent = message.ok
        ? (message.value ?? "")
        : (message.error ?? "unable to read hooks");
      return true;
    },
  };
}
