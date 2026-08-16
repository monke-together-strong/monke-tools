import path from "node:path";

/** Compare two filesystem paths using Monke's lexical path identity. */
export function samePath(left: string, right: string) {
  return path.normalize(left) === path.normalize(right);
}
