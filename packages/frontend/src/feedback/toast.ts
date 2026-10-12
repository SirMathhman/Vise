export type ToastKind = "info" | "success" | "error";

/** How long a toast stays, by kind: errors stay until read longer. */
const LIFETIME_MS: Record<ToastKind, number> = {
  info: 4000,
  success: 3000,
  error: 8000,
};

/** At most this many toasts at once; the oldest goes first. */
const MAX_TOASTS = 4;

let region: HTMLElement | null = null;

function host(): HTMLElement {
  if (region) return region;
  region = document.createElement("div");
  region.className = "toasts";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  document.body.appendChild(region);
  return region;
}

/**
 * A short message in the corner of the page that goes away by itself (or on
 * its ×): problems of the workspace, the terminal, the browser view or an
 * attachment, which are not part of the conversation and used to overwrite
 * one another in the header's status text.
 */
export function toast(text: string, kind: ToastKind = "info"): void {
  const list = host();
  const item = document.createElement("div");
  item.className = `toast toast--${kind}`;
  const body = document.createElement("span");
  body.className = "toast-text";
  body.textContent = text;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn--remove";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  const remove = (): void => item.remove();
  close.addEventListener("click", remove);
  item.append(body, close);
  list.appendChild(item);
  while (list.children.length > MAX_TOASTS) list.firstElementChild?.remove();
  setTimeout(remove, LIFETIME_MS[kind]);
}
