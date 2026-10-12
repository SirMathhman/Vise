import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { noFolderRoot } from "../../data-dir.ts";
import { HookStore } from "../../edge-sources.ts";
import { McpHub } from "../../mcp/mcp-hub.ts";

/**
 * The session roots the web server hosts. A connection picks its root when it
 * opens (a `root` query parameter) and keeps it for life; the server never
 * moves a session to another root. Hooks live in the root's `.viserc.json`, so
 * connections on the same root share one `HookStore` and one `McpHub` (the
 * MCP server processes), which is closed when the last connection leaves.
 */
export class RootRegistry {
  private readonly stores = new Map<
    string,
    { store: HookStore; hub: McpHub; refs: number }
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
    // The no-folder stores directory is not a project a session can be rooted in.
    if (root.toLowerCase() === noFolderRoot.toLowerCase()) return null;
    try {
      return statSync(root).isDirectory() ? root : null;
    } catch {
      return null;
    }
  }

  /** Whether sessions are using `root` (the explorer API serves only such roots). */
  isActive(root: string): boolean {
    return (this.stores.get(root)?.refs ?? 0) > 0;
  }

  /** Register a connection on `root`; returns that root's shared hook store and its MCP hub (started, not necessarily ready). */
  acquire(root: string): { store: HookStore; hub: McpHub } {
    let entry = this.stores.get(root);
    if (!entry) {
      // A no-folder root is generated, so it may not exist yet; servers start inside it.
      if (root.toLowerCase() === noFolderRoot.toLowerCase()) {
        mkdirSync(root, { recursive: true });
      }
      entry = { store: new HookStore(root), hub: new McpHub(root), refs: 0 };
      void entry.hub.start();
    }
    entry.refs++;
    this.stores.set(root, entry);
    return entry;
  }

  /** The connection on `root` closed. */
  release(root: string): void {
    const entry = this.stores.get(root);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      this.stores.delete(root);
      void entry.hub.close();
    }
  }

  /** Stop every MCP server (the server is shutting down). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.stores.values()].map((e) => e.hub.close()));
  }
}

/** The Windows Explorer-style folder chooser (IFileOpenDialog in folder mode), via COM interop. */
const FOLDER_DIALOG_CS = `
using System;
using System.Runtime.InteropServices;
public static class FolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCom {}
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint mask, out uint attribs);
    void Compare(IShellItem psi, uint hint, out int order);
  }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr f);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr p, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint o);
    void GetOptions(out uint o);
    void SetDefaultFolder(IShellItem s);
    void SetFolder(IShellItem s);
    void GetFolder(out IShellItem s);
    void GetCurrentSelection(out IShellItem s);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName(out IntPtr n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem s);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bc, ref Guid riid, out IShellItem item);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static string Pick(string start, string title) {
    var dlg = (IFileOpenDialog)new FileOpenDialogCom();
    dlg.SetOptions(0x20 | 0x40);
    dlg.SetTitle(title);
    try {
      var iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
      IShellItem folder;
      SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
      dlg.SetFolder(folder);
    } catch (Exception) {}
    if (dlg.Show(GetForegroundWindow()) != 0) return "";
    IShellItem item;
    dlg.GetResult(out item);
    IntPtr name;
    item.GetDisplayName(0x80058000, out name);
    var path = Marshal.PtrToStringUni(name);
    Marshal.FreeCoTaskMem(name);
    return path;
  }
}
`;

/**
 * Show the operating system's folder chooser on this machine (the server runs
 * locally, so its dialog is the user's) and return the chosen directory, or
 * null when cancelled. A web page cannot learn a folder's absolute path
 * itself, which is why the server asks.
 */
export function pickFolder(startDir: string): Promise<string | null> {
  const script = [
    `Add-Type -TypeDefinition @'${FOLDER_DIALOG_CS}'@`,
    `[FolderPicker]::Pick('${startDir.replaceAll("'", "''")}', 'Choose the root folder for a new Vise session')`,
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((done) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-EncodedCommand", encoded],
      { windowsHide: true },
    );
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    proc.on("error", () => done(null));
    proc.on("close", () => done(out.trim() || null));
  });
}
