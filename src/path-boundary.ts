import path from "node:path";

import { MonkeError } from "./errors.ts";

/** Require a path to be an immediate child of a managed directory boundary. */
export function assertDirectChildPath(candidate: string, parent: string, label: string) {
  const resolvedParent = path.resolve(parent);
  if (path.dirname(candidate) !== resolvedParent) {
    throw new MonkeError(`${label} must be a direct child of ${resolvedParent}`);
  }
}
