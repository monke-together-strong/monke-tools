import path from "node:path";

/** Compare two filesystem paths using Monke's lexical path identity. */
export function samePath(left: string, right: string) {
  return path.normalize(left) === path.normalize(right);
}

/** Removal of either nested path can affect work owned at the other path. */
export function worktreePathsOverlap(left: string, right: string) {
  return [path.relative(left, right), path.relative(right, left)].some(
    (relative) =>
      relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}
