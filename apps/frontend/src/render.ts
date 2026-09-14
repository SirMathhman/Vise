export async function render(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <main>
      <h1>Vise</h1>
      <p>Vanilla TypeScript frontend powered by Vite.</p>
      <p id="status">Fetching backend status&hellip;</p>
    </main>
  `;
  const status = root.querySelector<HTMLParagraphElement>("#status");
  if (!status) return;

  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { status: string };
    status.textContent = `Backend: ${data.status}`;
  } catch (err) {
    status.textContent = `Backend: unreachable (${(err as Error).message})`;
  }
}
