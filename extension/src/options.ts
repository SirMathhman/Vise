import { DEFAULT_PORT, getPort } from "./config.ts";

/** Options page: the port the Vise server listens on (`PORT`, default 3000). */
const port = document.getElementById("port") as HTMLInputElement;
const note = document.getElementById("note") as HTMLElement;

void getPort().then((value) => {
  port.value = String(value);
});

document.getElementById("save")?.addEventListener("click", () => {
  const n = Number(port.value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 65535;
  void browser.storage.local
    .set({ port: valid ? n : DEFAULT_PORT })
    .then(() => {
      note.textContent = valid
        ? "saved: reload the extension to reconnect"
        : `not a valid port; using ${DEFAULT_PORT}`;
    });
});
