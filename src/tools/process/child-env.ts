import { PROVIDER_KEY_VARIABLES } from "../../providers/provider.ts";
// The variables no child process may receive: the model key, and the web token of the browser server.
const WITHHELD = [...PROVIDER_KEY_VARIABLES, "VISE_WEB_TOKEN"];

// A copy of the environment without the withheld variables, for every process Vise starts. Bun loads
// .env into process.env itself, so removing a variable from process.env does not keep it out of a child.
export function childEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !WITHHELD.includes(name.toUpperCase())) {
      env[name] = value;
    }
  }
  return env;
}
