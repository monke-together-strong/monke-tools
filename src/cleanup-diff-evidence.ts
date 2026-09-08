import * as z from "zod";

import type { Runtime } from "./types.ts";

const OidSchema = z.string().regex(/^[\da-f]{40}$/u);

export interface MatchingMergeDiff {
  changeHash: string;
  mergeBase: string;
  mergeParent: string;
}

/** False is a mismatch/unsupported history; null means required Git evidence is unavailable. */
export function inspectMatchingMergeDiff(
  runtime: Runtime,
  sourceRoot: string,
  head: string,
  defaultHead: string,
  merge: string
): MatchingMergeDiff | false | null {
  const git = (args: string[]) => runtime.exec("git", args, { cwd: sourceRoot }).stdout;
  try {
    if (git(["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
      return null;
    }
    if (git(["rev-list", "--min-parents=2", `${defaultHead}..${head}`]).trim() !== "") {
      return false;
    }
    const bases = git(["merge-base", "--all", defaultHead, head]).trim().split("\n");
    if (bases.length !== 1) {
      return false;
    }
    const mergeBase = OidSchema.parse(bases[0]);
    const mergeParent = OidSchema.parse(git(["rev-parse", `${merge}^1`]).trim());
    const changes = (before: string, after: string) =>
      git([
        "-c",
        "core.quotePath=true",
        "diff-tree",
        "-r",
        "--raw",
        "--no-commit-id",
        "--no-abbrev",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--no-color",
        "--ignore-submodules=none",
        before,
        after,
        "--"
      ]);
    // Raw tree deltas include every path, mode and full before/after object ID.
    // Quoted paths preserve arbitrary filename bytes through Runtime's UTF-8 text output.
    // They preserve binary/whitespace distinctions without text diff drivers or patch normalization.
    const branchChanges = changes(mergeBase, head);
    if (branchChanges === "" || branchChanges !== changes(mergeParent, merge)) {
      return false;
    }
    return {
      changeHash: new Bun.CryptoHasher("sha256").update(branchChanges).digest("hex"),
      mergeBase,
      mergeParent
    };
  } catch {
    return null;
  }
}
