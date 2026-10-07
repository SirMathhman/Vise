import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { HookStore } from "../edge-sources.ts";

/**
 * The session roots the web server hosts. A connection picks its root when it
 * opens (a `root` query parameter) and keeps it for life; the server never
 * moves a session to another root. Hooks live in the root's `.viserc.json`, so
 * connections on the same root share one `HookStore`.
 */
export class RootRegistry {
  private readonly stores = new Map<
    string,
    { store: HookStore; refs: number }
  >();

  /** `defaultRoot` is where a connection with no `root` parameter lands. */
  constructor(readonly defaultRoot: string) {}

  /**
   * The absolute root a `root` parameter names, or null when it is not an
   * existing directory. A missing parameter means the default root.
   */
  resolve(param: string | null): string | null {
    if (!param) return this.defaultRoot;
    if (!isAbsolute(param)) return null;
    const root = resolve(param);
    try {
      return statSync(root).isDirectory() ? root : null;
    } catch {
      return null;
    }
  }

  /** Whether sessions are using `root` (the explorer API serves only such roots). */
  isActive(root: string): boolean {
    return root === this.defaultRoot || (this.stores.get(root)?.refs ?? 0) > 0;
  }

  /** Register a connection on `root`; returns that root's shared hook store. */
  acquire(root: string): HookStore {
    const entry = this.stores.get(root) ?? {
      store: new HookStore(root),
      refs: 0,
    };
    entry.refs++;
    this.stores.set(root, entry);
    return entry.store;
  }

  /** The connection on `root` closed. */
  release(root: string): void {
    const entry = this.stores.get(root);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) this.stores.delete(root);
  }
}

/**
 * Show the operating system's folder chooser on this machine (the server runs
 * locally, so its dialog is the user's) and return the chosen directory, or
 * null when cancelled. A web page cannot learn a folder's absolute path
 * itself, which is why the server asks.
 */
export function pickFolder(startDir: string): Promise<string | null> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Choose the root folder for a new Vise session'",
    `$dialog.SelectedPath = '${startDir.replaceAll("'", "''")}'`,
    "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }",
  ].join("; ");
  return new Promise((done) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", script],
      {
        windowsHide: false,
      },
    );
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    proc.on("error", () => done(null));
    proc.on("close", () => done(out.trim() || null));
  });
}
