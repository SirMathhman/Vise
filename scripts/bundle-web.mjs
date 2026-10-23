// Joins the compiled web scripts into web/app.js, which is the one script the page loads. The files share one scope, so
// each one's top-level code can use what the files before it declared. The order is the order they must run in.
import { readdirSync, readFileSync, writeFileSync, watch } from "node:fs";
import { join } from "node:path";

const compiled = "node_modules/.cache/vise-web";
// Each file may only use what the files before it declare, so the order runs from the leaves up to app.ts.
const order = [
  "markdown",
  "http",
  "tabs",
  "chat",
  "panels/tools",
  "panels/profile",
  "layout",
  "panels/viewers",
  "panels/sessions",
  "panels/files",
  "panels/notes",
  "app",
];

function bundle() {
  // A compiled file that is not in the order would be left out of the page without an error, so it is refused here.
  // Paths use forward slashes, as the order does, whatever the platform.
  const unlisted = readdirSync(compiled, { recursive: true })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".js") && !order.includes(file.slice(0, -3)));
  if (unlisted.length > 0) {
    throw new Error(`Not in the bundle order, add to scripts/bundle-web.mjs: ${unlisted.join(", ")}`);
  }
  const parts = order.map((name) => readFileSync(join(compiled, `${name}.js`), "utf8"));
  writeFileSync("web/app.js", parts.join("\n"));
}

if (process.argv.includes("--watch")) {
  // The compiler is still writing its first output, so a file that cannot be read yet waits for the next change. Any
  // other failure is shown, so a stale bundle is never left without a message.
  const retry = () => {
    try {
      bundle();
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(err.message);
      }
    }
  };
  retry();
  watch(compiled, { recursive: true }, retry);
} else {
  bundle();
}
