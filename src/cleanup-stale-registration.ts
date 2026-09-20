import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { readOnlyCleanupRuntime } from "./cleanup-eligibility.ts";
import { MonkeError } from "./errors.ts";
import { listWorktrees } from "./git.ts";
import { samePath } from "./path-identity.ts";
import { sha256 } from "./sha256.ts";
import type { Runtime } from "./types.ts";
import { assertCanonicalSourceCheckout, assertWorktreeUnlocked } from "./worktree-safety.ts";

/** Missing directories can still have unique staged work in their registration's index. */
export function inspectStaleRegistration(runtime: Runtime, source: string, target: string) {
  // lstat also preserves broken symlinks; errors other than absence must fail closed.
  if (lstatSync(target, { throwIfNoEntry: false })) {
    return null;
  }
  const readOnly = readOnlyCleanupRuntime(runtime);
  assertCanonicalSourceCheckout(readOnly, source);
  const entry = listWorktrees(readOnly, source).find((worktree) => samePath(worktree.path, target));
  if (!entry?.prunable || !entry.branch) {
    throw new MonkeError(`Stale registration needs a preserved branch: ${target}`);
  }
  assertWorktreeUnlocked(entry);
  const git = (args: string[]) => readOnly.exec("git", args, { cwd: source }).stdout.trim();
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const registrations = path.join(common, "worktrees");
  const matches = readdirSync(registrations).filter((name) => {
    const gitdir = path.join(registrations, name, "gitdir");
    return (
      lstatSync(gitdir, { throwIfNoEntry: false })?.isFile() &&
      samePath(readFileSync(gitdir, "utf-8").trim(), path.join(target, ".git"))
    );
  });
  const [name] = matches;
  if (matches.length !== 1 || !name) {
    throw new MonkeError(`Cannot identify stale registration: ${target}`);
  }
  const admin = path.join(registrations, name);
  if (!samePath(realpathSync.native(admin), admin)) {
    throw new MonkeError(`Noncanonical stale registration: ${admin}`);
  }
  const read = (file: string) => {
    const location = path.join(admin, file);
    if (!lstatSync(location).isFile()) {
      throw new MonkeError(`Invalid stale registration file: ${location}`);
    }
    return readFileSync(location);
  };
  if (!samePath(path.resolve(admin, read("commondir").toString().trim()), common)) {
    throw new MonkeError(`Stale registration belongs to another repository: ${target}`);
  }
  // Keep in-progress operations, per-worktree refs and unfamiliar metadata for manual recovery.
  const allowed = new Set([
    "HEAD",
    "ORIG_HEAD",
    "FETCH_HEAD",
    "COMMIT_EDITMSG",
    "commondir",
    "gitdir",
    "index",
    "logs",
    "refs"
  ]);
  if (
    readdirSync(admin).some(
      (file) => !allowed.has(file) || lstatSync(path.join(admin, file)).isSymbolicLink()
    ) ||
    (lstatSync(path.join(admin, "refs"), { throwIfNoEntry: false }) &&
      readdirSync(path.join(admin, "refs")).length > 0)
  ) {
    throw new MonkeError(`Stale registration has additional recovery metadata: ${target}`);
  }
  const headRef = read("HEAD").toString().trim();
  if (headRef !== `ref: refs/heads/${entry.branch}`) {
    throw new MonkeError(`Stale registration HEAD is not retained by its branch: ${target}`);
  }
  const args = [`--git-dir=${admin}`, `--work-tree=${target}`];
  const head = git([...args, "rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[\da-f]{40}$/u.test(head)) {
    throw new MonkeError(`Invalid stale registration HEAD: ${target}`);
  }
  const index = sha256(read("index"));
  if (
    git([...args, "ls-files", "-v", "-z"])
      .split("\0")
      .some((line) => /^[a-zS] /u.test(line))
  ) {
    throw new MonkeError(`Stale registration has hidden index entries: ${target}`);
  }
  git([
    ...args,
    "diff",
    "--cached",
    "--quiet",
    "--no-ext-diff",
    "--ita-visible-in-index",
    "--ignore-submodules=none",
    head,
    "--"
  ]);
  if (lstatSync(target, { throwIfNoEntry: false })) {
    throw new MonkeError(`Stale worktree path reappeared: ${target}`);
  }
  return JSON.stringify({ admin, head, headRef, index });
}
