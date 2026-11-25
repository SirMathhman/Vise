import { homedir } from "node:os";
import path from "node:path";

/**
 * The per-user config folder, outside the project so the model's tools and the sandbox never
 * see what is stored there. VISE_CONFIG_DIR overrides the folder.
 *
 * @returns The config folder's path.
 */
export function configDir(): string {
  return (
    process.env.VISE_CONFIG_DIR ??
    path.join(process.env.APPDATA ?? homedir(), "vise")
  );
}
