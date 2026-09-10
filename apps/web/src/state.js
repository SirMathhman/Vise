/**
 * Shared app state for values that more than one behavior module needs.
 *
 * Kept as a plain module (no DOM, no framework) so sibling behavior modules
 * can share state through an explicit contract instead of reading each
 * other's DOM. Add new shared state here as features grow.
 */

let openFilePath = null; // path of the file currently shown in the viewer

/**
 * Record the file currently open in the viewer.
 * @param {string|null} path - The file's relative path, or null if none.
 */
export function setOpenFilePath(path) {
  openFilePath = path;
}

/**
 * Get the file currently open in the viewer.
 * @returns {string|null} The file's relative path, or null if none.
 */
export function getOpenFilePath() {
  return openFilePath;
}
