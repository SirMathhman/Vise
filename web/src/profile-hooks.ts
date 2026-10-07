import type { HooksFields } from "./hooks-panel.ts";

/**
 * The hooks section of the profile editor: one checkbox per hook, ticked when
 * the hook is bound to the selected profile. A hook bound to some profiles runs
 * only with those; a hook ticked nowhere runs with every profile. Toggling a
 * box applies at once through the same `/hooks bind|unbind` command as the
 * terminal and the hooks panel.
 */
export function renderProfileHooks(
  container: HTMLElement,
  hooks: HooksFields,
  profile: string,
  edit: (line: string) => void,
): void {
  container.textContent = "";
  if (!profile) return;
  const heading = document.createElement("div");
  heading.className = "files-path";
  heading.textContent =
    "hooks — tick to run a hook only with this profile (a hook ticked in no profile always runs; applies immediately)";
  container.appendChild(heading);
  const list = document.createElement("ul");
  list.className = "tools-list";
  for (const phase of ["pre", "post"] as const) {
    (hooks[phase] ?? []).forEach((hook, i) => {
      const item = document.createElement("li");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = hook.profiles.includes(profile);
      box.addEventListener("change", () =>
        edit(
          `/hooks ${box.checked ? "bind" : "unbind"} ${phase} ${i + 1} ${profile}`,
        ),
      );
      const label = document.createElement("label");
      label.append(
        box,
        document.createTextNode(`${phase} ${i + 1}. ${hook.command}`),
      );
      item.appendChild(label);
      list.appendChild(item);
    });
  }
  if (list.childElementCount === 0) {
    list.appendChild(document.createElement("li")).textContent = "no hooks";
  }
  container.appendChild(list);
}
