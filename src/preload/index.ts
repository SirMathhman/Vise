import { contextBridge } from "electron";

// Expose a minimal, explicit API to the renderer. Keep this surface small:
// only expose what the UI actually needs, and avoid exposing Node/Electron
// globals directly.
contextBridge.exposeInMainWorld("platform", {
  name: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
