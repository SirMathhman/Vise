// This is a module (the `export` below) so that `declare global` is allowed.
// The preload script (see src/preload/index.ts) exposes a small API on
// `window.platform` via contextBridge. It is intentionally minimal and does
// not depend on any Node/Electron globals.
export {};

declare global {
  interface Window {
    platform: {
      name: string;
      versions: {
        electron: string;
        chrome: string;
        node: string;
      };
    };
  }
}

function setText(selector: string, value: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (el) {
    el.textContent = value;
  }
}

const info = window.platform;

setText("[data-platform]", info.name);
setText("[data-electron]", info.versions.electron);
setText("[data-chrome]", info.versions.chrome);
setText("[data-node]", info.versions.node);
