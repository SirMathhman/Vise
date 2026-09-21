// Rewrites a single key in .env.local so a config value survives a
// restart. The only module that writes config to disk. The file is created
// if it does not exist.
import { readFileSync, writeFileSync } from "node:fs";

export function persistEnvVar(
  envPath: string,
  key: string,
  value: string,
): void {
  let contents = "";
  try {
    contents = readFileSync(envPath, "utf-8");
  } catch {
    contents = "";
  }
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  let updated: string;
  if (pattern.test(contents)) {
    updated = contents.replace(pattern, line);
  } else if (contents.length === 0) {
    updated = `${line}\n`;
  } else {
    updated = `${contents.replace(/\n*$/, "")}\n${line}\n`;
  }
  writeFileSync(envPath, updated, "utf-8");
}
