import { execFileSync } from "node:child_process";
import path from "node:path";

// The most files one folder may directly contain, counting every git-tracked or visible file
// of any type and not counting subfolders.
const LIMIT = 10;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// Files per folder, read once per lint run from the same list `git ls-files` gives.
let counts;
function folderCounts() {
  if (counts === undefined) {
    counts = new Map();
    const listed = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    for (const file of listed.split("\0")) {
      if (file !== "") {
        const folder = path.posix.dirname(file);
        counts.set(folder, (counts.get(folder) ?? 0) + 1);
      }
    }
  }
  return counts;
}

// Folders already reported in this run, so each is reported once.
const reported = new Set();

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Limit the number of files a git-tracked folder may directly contain.",
    },
    schema: [],
    messages: {
      tooMany:
        "Folder {{folder}} has {{count}} files; the limit is {{limit}}. Move some into subfolders.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const relative = path
          .relative(REPO_ROOT, context.filename)
          .split(path.sep)
          .join("/");
        const folder = path.posix.dirname(relative);
        const count = folderCounts().get(folder) ?? 0;
        if (count > LIMIT && !reported.has(folder)) {
          reported.add(folder);
          context.report({
            node,
            messageId: "tooMany",
            data: { folder, count: String(count), limit: String(LIMIT) },
          });
        }
      },
    };
  },
};
