// Copies static renderer assets (HTML, CSS, images, ...) into dist so they
// sit next to the compiled renderer JS. Add new asset directories here as the
// app grows.
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRenderer = join(root, "src", "renderer");
const distRenderer = join(root, "dist", "renderer");

if (!existsSync(distRenderer)) {
  mkdirSync(distRenderer, { recursive: true });
}

for (const file of ["index.html"]) {
  cpSync(join(srcRenderer, file), join(distRenderer, file));
}

console.log("Copied renderer assets to dist/renderer");
