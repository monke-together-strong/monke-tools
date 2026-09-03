const MAX_CONCURRENT_PREPARATIONS = 4;

/** One independently schedulable Worktree preparation. */
export interface WorktreePreparation<T> {
  prepare: () => T;
  prepareAsync: () => Promise<T>;
  sourceRoot: string;
}

/** Run every preparation to settlement for synchronous embedding callers. */
export function runWorktreePreparations<T>(preparations: WorktreePreparation<T>[]) {
  const failures: unknown[] = [];
  const results = new Map<string, T>();
  for (const preparation of preparations) {
    try {
      results.set(preparation.sourceRoot, preparation.prepare());
    } catch (error) {
      failures.push(error);
    }
  }
  throwFirstFailure(failures);
  return results;
}

/** Run every preparation to settlement with bounded internal concurrency. */
export async function runWorktreePreparationsAsync<T>(preparations: WorktreePreparation<T>[]) {
  const failures: unknown[] = [];
  const results = new Map<string, T>();
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < preparations.length) {
      const preparation = preparations[nextIndex];
      nextIndex += 1;
      if (!preparation) {
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- Each worker claims one task at a time so the shared worker count remains the concurrency bound.
        results.set(preparation.sourceRoot, await preparation.prepareAsync());
      } catch (error) {
        failures.push(error);
      }
    }
  };

  const workerCount = Math.min(MAX_CONCURRENT_PREPARATIONS, preparations.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  throwFirstFailure(failures);
  return results;
}

function throwFirstFailure(failures: unknown[]) {
  const [failure] = failures;
  if (failure !== undefined) {
    throw failure instanceof Error
      ? failure
      : new Error("Worktree preparation failed with a non-Error value");
  }
}
