import "./src/settings/settings-init.ts";
import { runMaintenance } from "./src/build/maintenance.ts";

// Terminal entry point. A maintenance flag (--version, --install-extension,
// --setup-playwright) does its job and ends here; otherwise the REPL starts.
if (!(await runMaintenance())) await import("./src/terminal-main.ts");
