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
