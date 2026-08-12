/**
 * Frontend operation queue for worktree paths. Git serializes its own lock
 * files, but application invariants (dependent-task records, terminal gates,
 * and outcome transitions) span multiple IPC calls. Operations that share a
 * parent or checkout path must therefore run as one frontend transaction.
 */

const tails = new Map<string, Promise<void>>();
const busyCounts = new Map<string, number>();

const pathKey = (path: string): string => path.replace(/\/+$/, "") || "/";

export const worktreePathOperationPending = (path: string): boolean =>
  (busyCounts.get(pathKey(path)) ?? 0) > 0;

export async function withWorktreePathsLocked<T>(
  paths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(paths.map(pathKey))].sort();
  const previous = Promise.all(keys.map((key) => tails.get(key) ?? Promise.resolve()))
    .then(() => undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  for (const key of keys) {
    tails.set(key, tail);
    busyCounts.set(key, (busyCounts.get(key) ?? 0) + 1);
  }

  await previous;
  try {
    return await operation();
  } finally {
    release();
    for (const key of keys) {
      const remaining = (busyCounts.get(key) ?? 1) - 1;
      if (remaining > 0) busyCounts.set(key, remaining);
      else busyCounts.delete(key);
      if (tails.get(key) === tail) tails.delete(key);
    }
  }
}
