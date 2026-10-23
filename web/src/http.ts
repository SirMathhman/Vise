// Helpers shared by the chat, the side panels and the file viewers.

// The text of a thrown value, as it is shown to the user.
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// One JSON request to the server. A failure is thrown with the server's reason.
async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

// Shows a message in one of the side panel's status lines. An error is shown as an error.
function showStatus(status: HTMLParagraphElement, message: string, isError: boolean): void {
  status.textContent = message;
  status.className = isError ? "error" : "summary";
  status.hidden = false;
}
