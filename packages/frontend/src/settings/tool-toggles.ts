/** Turn a tools-panel checkbox change into a `/tool <name|category> enable|disable` line. */
export function bindToolToggles(
  list: HTMLElement,
  request: (line: string) => void,
): void {
  list.addEventListener("change", (event) => {
    const checkbox = event.target;
    if (!(checkbox instanceof HTMLInputElement) || !checkbox.value) return;
    const verb = checkbox.checked ? "enable" : "disable";
    const row = checkbox.closest("li");
    if (row?.classList.contains("tool-category")) {
      // Show the whole group switching at once; the refreshed list then
      // corrects anything the server kept (opt-in tools stay off).
      checkbox.indeterminate = false;
      for (let r = row.nextElementSibling; r; r = r.nextElementSibling) {
        if (r.classList.contains("tool-category")) break;
        const box = r.querySelector<HTMLInputElement>("input");
        if (box) box.checked = checkbox.checked;
        r.classList.toggle("disabled", !checkbox.checked);
      }
    } else {
      row?.classList.toggle("disabled", !checkbox.checked);
    }
    request(`/tool ${checkbox.value} ${verb}`);
  });
}

/** Narrow a tool list to the tools whose name contains the filter text; a category shows while any of its tools does. */
export function filterToolList(list: HTMLElement, text: string): void {
  const wanted = text.trim().toLowerCase();
  let head: HTMLElement | null = null;
  let headVisible = false;
  const closeGroup = (): void => {
    head?.classList.toggle("hidden", !headVisible);
  };
  for (const row of list.querySelectorAll<HTMLElement>(":scope > li")) {
    if (row.classList.contains("tool-category")) {
      closeGroup();
      head = row;
      headVisible = false;
      continue;
    }
    const name = row.querySelector("input")?.value ?? row.textContent ?? "";
    const shown = !wanted || name.toLowerCase().includes(wanted);
    row.classList.toggle("hidden", !shown);
    if (shown) headVisible = true;
  }
  closeGroup();
}
