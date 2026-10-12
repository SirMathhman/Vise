// The Firefox extension's files, embedded so `--install-extension` can write
// them out. `extension/dist/*.js` is built by `bun run build:ext`, which must
// run first. Imported only when needed, so running from source does not
// require the build.
import background from "../../../../apps/extension/dist/background.js" with { type: "file" };
import dialogs from "../../../../apps/extension/dist/dialogs.js" with { type: "file" };
import options from "../../../../apps/extension/dist/options.js" with { type: "file" };
import sidebar from "../../../../apps/extension/dist/sidebar.js" with { type: "file" };
import manifest from "../../../../apps/extension/manifest.json" with { type: "file" };
import optionsHtml from "../../../../apps/extension/options.html" with { type: "file" };
import sidebarHtml from "../../../../apps/extension/sidebar.html" with { type: "file" };

// Bun types some of these imports as modules or bundles; with `type: "file"` they are paths.
const path = (imported: unknown): string => imported as string;

/** The extension's files by path inside the extension folder. */
export const EXTENSION_FILES: Readonly<Record<string, string>> = {
  "manifest.json": path(manifest),
  "sidebar.html": path(sidebarHtml),
  "options.html": path(optionsHtml),
  "dist/background.js": path(background),
  "dist/dialogs.js": path(dialogs),
  "dist/options.js": path(options),
  "dist/sidebar.js": path(sidebar),
};
