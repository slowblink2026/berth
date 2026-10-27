/**
 * Which dock is working, and which may be closed to make room.
 *
 * Docks are independent: each site has its own Chrome profile, so two tasks on
 * different sites run side by side and only tasks on the same dock queue up.
 * That only holds if making room for a new dock never closes one that is in
 * the middle of a task, which is what the busy set is for.
 */

const queues = new Map<string, Promise<unknown>>();
const working = new Set<string>();

/** True while a task on this dock is queued or running. */
export function isBusy(id: string): boolean {
  return working.has(id);
}

export function busyCount(): number {
  return working.size;
}

/** Run fn once every earlier task on this dock has finished. */
export function enqueueFor<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  working.add(key);
  const run = prior.then(fn, fn);
  const settled: Promise<unknown> = run.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    // Only the last task queued on this dock clears it; an earlier one
    // finishing says nothing about the ones still behind it.
    if (queues.get(key) === settled) working.delete(key);
  });
  queues.set(key, settled);
  return run;
}

/**
 * The docks to close so that opening one more stays within max, oldest first.
 *
 * A dock with work on it is never offered, however old it is: closing its
 * context would kill a task that is still running. If that leaves nothing to
 * close, the caller has no room and must not open another.
 */
export function evictable<T extends { id: string; touched: number }>(
  open: readonly T[],
  keepId: string,
  max: number,
): T[] {
  if (open.length < max) return [];
  return open
    .filter((dock) => dock.id !== keepId && !working.has(dock.id))
    .sort((a, b) => a.touched - b.touched)
    .slice(0, open.length - max + 1);
}

/** Test seam: forget all queue state. */
export function resetScheduler(): void {
  queues.clear();
  working.clear();
}
