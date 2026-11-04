// Fails when a directory holds more than 10 tracked files. ESLint has no rule for
// this, so ARCHITECTURE.md's limit is checked here.
const LIMIT = 10;

const files = (await Bun.$`git ls-files`.text()).split("\n").filter(Boolean);
const counts = new Map<string, number>();
for (const file of files) {
  const slash = file.lastIndexOf("/");
  const dir = slash < 0 ? "." : file.slice(0, slash);
  counts.set(dir, (counts.get(dir) ?? 0) + 1);
}

const over = [...counts].filter(([, count]) => count > LIMIT);
for (const [dir, count] of over) {
  console.error(`${dir}: ${count} files (limit ${LIMIT})`);
}
process.exit(over.length > 0 ? 1 : 0);
