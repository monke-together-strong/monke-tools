import { MonkeError } from "./errors.ts";
import type { SessionAction } from "./session-lifecycle-progress.ts";
import type { Runtime } from "./types.ts";

function git(runtime: Runtime, root: string, args: string[], allowFailure = false) {
  return runtime.exec("git", args, {
    allowFailure,
    cwd: root,
    env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" }
  });
}

function assertDetachedHead(runtime: Runtime, worktree: string, head: string) {
  const branch = git(runtime, worktree, ["symbolic-ref", "-q", "HEAD"], true);
  const current = git(runtime, worktree, ["rev-parse", "--verify", "HEAD"]).stdout.trim();
  if (branch.exitCode !== 1 || current !== head) {
    throw new MonkeError(`Detached HEAD changed before preservation at ${worktree}`);
  }
}

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function retainedHeadAction(
  sourceRoot: string,
  worktreePath: string,
  head: string
): SessionAction & { retainedRef: string } {
  if (!/^[\da-f]{40}$/u.test(head)) {
    throw new MonkeError("Cannot preserve an invalid detached HEAD");
  }
  const retainedRef = `refs/monke/retained/${head}`;
  return {
    recoveryCommand: `git -C ${quote(sourceRoot)} worktree add --detach ${quote(worktreePath)} ${quote(retainedRef)}`,
    retainedRef,
    sourceRoot,
    step: "head-preservation",
    worktreePath
  };
}

/** A common-repository ref survives worktree removal and later reflog expiration. */
export function preserveDetachedHead(
  runtime: Runtime,
  source: string,
  worktree: string,
  head: string
) {
  assertDetachedHead(runtime, worktree, head);
  const { retainedRef: ref } = retainedHeadAction(source, worktree, head);
  const symbolic = git(runtime, source, ["symbolic-ref", "-q", ref], true);
  if (symbolic.exitCode !== 1) {
    throw new MonkeError(`Cannot preserve detached HEAD: symbolic retention ref at ${ref}`);
  }
  const existing = git(runtime, source, ["show-ref", "--verify", "--quiet", ref], true);
  if (existing.exitCode === 1) {
    // Compare-and-set: never overwrite a ref created between inspection and this write.
    git(runtime, source, ["update-ref", "--no-deref", ref, head, "0".repeat(40)]);
  } else if (existing.exitCode !== 0) {
    throw new MonkeError(`Cannot preserve detached HEAD: retention ref collision at ${ref}`);
  }
  assertRetainedHead(runtime, source, worktree, head);
}

/** Read both identities again immediately before removing the detached worktree. */
export function assertRetainedHead(
  runtime: Runtime,
  source: string,
  worktree: string,
  head: string
) {
  const { retainedRef: ref } = retainedHeadAction(source, worktree, head);
  const symbolic = git(runtime, source, ["symbolic-ref", "-q", ref], true);
  const retained = git(runtime, source, ["show-ref", "--verify", "--hash", ref], true);
  if (symbolic.exitCode !== 1 || retained.exitCode !== 0 || retained.stdout.trim() !== head) {
    throw new MonkeError(`Detached HEAD retention ref changed or could not be verified: ${ref}`);
  }
  assertDetachedHead(runtime, worktree, head);
}
