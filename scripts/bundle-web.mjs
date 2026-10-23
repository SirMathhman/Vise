// Joins the compiled web scripts into web/app.js, which is the one script the page loads. The files share one scope, so
// each one's top-level code can use what the files before it declared. The order is the order they must run in.
import { readFileSync, writeFileSync, watch } from "node:fs";
import { join } from "node:path";

const compiled = "node_modules/.cache/vise-web";
const order = ["markdown", "http", "viewers", "app"];

function bundle() {
  const parts = order.map((name) => readFileSync(join(compiled, `${name}.js`), "utf8"));
  writeFileSync("web/app.js", parts.join("\n"));
}

if (process.argv.includes("--watch")) {
  // The compiler is still writing its first output, so a bundle that cannot be read yet waits for the next change.
  const retry = () => {
    try {
      bundle();
    } catch {
      // Not ready: the next change bundles it.
    }
  };
  retry();
  watch(compiled, retry);
} else {
  bundle();
}
