import path from "node:path";

/** Compare two filesystem paths using Monke's lexical path identity. */
export function samePath(left: string, right: string) {
  return path.normalize(left) === path.normalize(right);
}

/** Whether a path is the parent itself or one of its lexical descendants. */
export function containsPath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Removal of either nested path can affect work owned at the other path. */
export function worktreePathsOverlap(left: string, right: string) {
  return containsPath(left, right) || containsPath(right, left);
}
