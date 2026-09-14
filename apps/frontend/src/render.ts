interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

interface LsResponse {
  path: string;
  items: DirEntry[];
}

export async function render(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <main>
      <h1>Vise</h1>
      <p>Vanilla TypeScript frontend powered by Vite.</p>
      <p id="status">Fetching backend status&hellip;</p>
      <section id="listing">
        <h2>Contents of <code id="ls-path"></code></h2>
        <ul id="ls-items" aria-label="files and directories"></ul>
      </section>
    </main>
  `;
  const status = root.querySelector<HTMLParagraphElement>("#status");
  const lsPath = root.querySelector<HTMLElement>("#ls-path");
  const list = root.querySelector<HTMLUListElement>("#ls-items");
  if (!status || !lsPath || !list) return;

  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { status: string };
    status.textContent = `Backend: ${data.status}`;
    status.classList.add("ok");
  } catch (err) {
    status.textContent = `Backend: unreachable (${(err as Error).message})`;
    status.classList.add("err");
  }

  await renderListing(list, lsPath);
}

async function renderListing(
  list: HTMLUListElement,
  lsPath: HTMLElement,
): Promise<void> {
  try {
    const res = await fetch("/api/ls");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as LsResponse;
    lsPath.textContent = data.path;
    list.innerHTML = "";
    for (const item of data.items) {
      const li = document.createElement("li");
      li.className = item.kind;
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = item.kind === "directory" ? "dir" : "file";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.name;
      li.append(badge, name);
      list.append(li);
    }
  } catch (err) {
    list.innerHTML = "";
    const li = document.createElement("li");
    li.className = "error";
    li.textContent = `Failed to load: ${(err as Error).message}`;
    list.append(li);
  }
}
