import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { containsPath } from "./path-identity.ts";

/** Follow native component order through aliases and `..`, projecting missing path components. */
export function resolveSkillPath(entry: string, boundary?: string) {
  const paths = new Set<string>();
  const absolute = path.isAbsolute(entry) ? entry : `${process.cwd()}${path.sep}${entry}`;
  const { root } = path.parse(absolute);
  const pending = absolute.slice(root.length).split(path.sep);
  let ancestor = root;
  let reachedBoundary = false;
  let escaped = false;
  let aliases = 0;
  while (pending.length > 0) {
    const part = pending.shift();
    if (!part || part === ".") {
      continue;
    }
    ancestor = part === ".." ? path.dirname(ancestor) : path.join(ancestor, part);
    paths.add(ancestor);
    if (boundary && containsPath(boundary, ancestor)) {
      reachedBoundary = true;
    } else if (reachedBoundary) {
      escaped = true;
    }
    if (part === ".." || !lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) {
      continue;
    }
    aliases += 1;
    if (aliases > 64) {
      throw new MonkeError(`Cyclic or excessive Skill path aliases: ${entry}`);
    }
    const target = readlinkSync(ancestor);
    if (path.isAbsolute(target)) {
      ancestor = path.parse(target).root;
      if (reachedBoundary) {
        escaped = true;
      }
      pending.unshift(...target.slice(ancestor.length).split(path.sep));
    } else {
      ancestor = path.dirname(ancestor);
      pending.unshift(...target.split(path.sep));
    }
  }
  return { escaped, paths, resolved: ancestor };
}
