import { loadSettingsFile } from "./settings-file.ts";

// Imported first by each entry point, so the settings file is applied before
// any other module's start-up code reads a setting.
loadSettingsFile();
