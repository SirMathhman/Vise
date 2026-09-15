import { createEntry } from "../api/client.js";

/**
 * Show an inline modal form for naming a new entry. The overlay is dismissed
 * by Cancel, Escape, or a click on the backdrop. On successful creation the
 * overlay is removed and `onCreated(name)` is invoked to refresh the tree.
 */
export function showCreateForm(
  kind: "file" | "directory",
  parentRel: string,
  onCreated: (name: string) => void
): void {
  const overlay = document.createElement("div");
  overlay.className = "create-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const form = document.createElement("form");
  form.className = "create-form";

  const title = document.createElement("h3");
  title.textContent = kind === "directory" ? "New directory" : "New file";

  const where = document.createElement("p");
  where.className = "create-where";
  where.textContent = `Create in: ${parentRel || "(root)"}`;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "create-input";
  input.placeholder = "name";
  input.autocomplete = "off";

  const error = document.createElement("p");
  error.className = "create-error";
  error.hidden = true;

  const row = document.createElement("div");
  row.className = "create-row";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => overlay.remove());
  const create = document.createElement("button");
  create.type = "button";
  create.className = "btn";
  create.textContent = "Create";
  create.addEventListener("click", () => {
    void submit();
  });
  row.append(cancel, create);

  form.append(title, where, input, error, row);
  overlay.append(form);
  document.body.append(overlay);
  input.focus();
  input.select();

  async function submit(): Promise<void> {
    const name = input.value.trim();
    if (!name) {
      showError("Please enter a name.");
      input.focus();
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      showError("The name cannot contain a slash.");
      input.focus();
      return;
    }
    create.disabled = true;
    try {
      await createEntry(kind, parentRel, name);
      overlay.remove();
      onCreated(name);
    } catch (err) {
      create.disabled = false;
      showError((err as Error).message);
      input.focus();
    }
  }

  function showError(msg: string): void {
    error.textContent = msg;
    error.hidden = false;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") overlay.remove();
    },
    { once: true }
  );
}
