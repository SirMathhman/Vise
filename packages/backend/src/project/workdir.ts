import path from "node:path";

/**
 * The project root. This file sits in packages/backend/src/project, so the root is four levels
 * up. It does not depend on the directory the backend was started from.
 */
export const PROJECT_ROOT = path.resolve(import.meta.dir, "../../../..");
