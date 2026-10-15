import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSecretName,
  listIndexable,
  readText,
} from "../../packages/backend/src/stores/semantic/walk.ts";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "vise-walk-"));
  const put = (path: string, text: string | Uint8Array): void => {
    mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...path.split("/")), text);
  };
  put("src/app.ts", "export const a = 1;\n");
  put("src/deep/util.ts", "export const b = 2;\n");
  put("README.md", "# hello\n");
  put("node_modules/dep/index.js", "x");
  put(".git/config", "x");
  put(".vise/vise.db", "x");
  put(".env", "TOKEN=abc");
  put("config/.env.production", "TOKEN=abc");
  put("server.key", "-----BEGIN");
  put("credentials.json", "{}");
  put("empty.txt", "");
  put("big.txt", "z".repeat(2000));
  put("image.bin", new Uint8Array([1, 2, 0, 3]));
  return root;
}

test("only ordinary, non-empty, small files are listed, with relative slash paths", () => {
  const root = project();
  const paths = listIndexable(root, 1000)
    .map((f) => f.path)
    .sort();
  expect(paths).toEqual(["README.md", "image.bin", "src/app.ts", "src/deep/util.ts"]);
});

test("secrets are never listed", () => {
  for (const name of [
    ".env",
    ".env.local",
    "server.key",
    "cert.pem",
    "id_rsa",
    "credentials.json",
    "secrets.yml",
    ".npmrc",
  ]) {
    expect(isSecretName(name)).toBe(true);
  }
  for (const name of ["app.ts", "environment.md", "keyboard.ts", "README.md"])
    expect(isSecretName(name)).toBe(false);
});

test("a binary file is turned away when read, text comes back whole", () => {
  const root = project();
  expect(readText(root, "image.bin")).toBeUndefined();
  expect(readText(root, "src/app.ts")).toBe("export const a = 1;\n");
  expect(readText(root, "no/such/file.ts")).toBeUndefined();
});
