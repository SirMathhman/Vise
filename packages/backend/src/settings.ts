import path from "node:path";

// The UI-saved key lives in the backend's .env file. `--no-env-file` in the
// backend scripts stops Bun from loading this file on its own, so the key
// saved here takes precedence over OPENROUTER_API_KEY from the environment.
const ENV_PATH = path.resolve(import.meta.dir, "../.env");
const KEY_NAME = "OPENROUTER_API_KEY";

async function readEnvLines(): Promise<string[]> {
  const file = Bun.file(ENV_PATH);
  if (!(await file.exists())) {
    return [];
  }
  return (await file.text()).split(/\r?\n/).filter((line) => line.length > 0);
}

function isKeyLine(line: string): boolean {
  return line.startsWith(`${KEY_NAME}=`);
}

async function writeEnvLines(lines: string[]): Promise<void> {
  await Bun.write(ENV_PATH, lines.map((line) => `${line}\n`).join(""));
}

export async function getSavedOpenRouterKey(): Promise<string | undefined> {
  const line = (await readEnvLines()).find(isKeyLine);
  const value = line?.slice(KEY_NAME.length + 1).trim();
  return value ? value : undefined;
}

// The UI-saved key wins; otherwise fall back to the environment variable.
export async function getOpenRouterKey(): Promise<string | undefined> {
  return (await getSavedOpenRouterKey()) ?? (process.env[KEY_NAME] || undefined);
}

export async function saveOpenRouterKey(apiKey: string): Promise<void> {
  const lines = (await readEnvLines()).filter((line) => !isKeyLine(line));
  lines.push(`${KEY_NAME}=${apiKey}`);
  await writeEnvLines(lines);
}

export async function clearSavedOpenRouterKey(): Promise<void> {
  await writeEnvLines((await readEnvLines()).filter((line) => !isKeyLine(line)));
}
