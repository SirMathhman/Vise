import "@vise/backend/src/settings/settings-init.ts";
import { runMaintenance } from "@vise/backend";

// Terminal entry point. A maintenance flag (--version, --install-extension,
// --setup-playwright) does its job and ends here; otherwise the REPL starts.
if (!(await runMaintenance())) await import("@vise/backend/src/terminal-main.ts");
