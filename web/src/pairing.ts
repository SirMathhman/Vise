/**
 * Inside the Firefox extension's sidebar, hand the extension the pairing token
 * it needs to connect to the server. The sidebar page (a `moz-extension://`
 * page that embeds this one) asks with a `vise-hello` message; the answer goes
 * only to that origin, so a web page that embeds Vise in a frame learns nothing.
 */
export function pairWithExtension(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string } | null;
    if (data?.type !== "vise-hello") return;
    if (!event.origin.startsWith("moz-extension://")) return;
    void fetch("/api/ext-token")
      .then((res) =>
        res.ok ? (res.json() as Promise<{ token: string }>) : null,
      )
      .then((body) => {
        if (body) {
          (event.source as Window | null)?.postMessage(
            { type: "vise-token", token: body.token },
            event.origin,
          );
        }
      });
  });
}
