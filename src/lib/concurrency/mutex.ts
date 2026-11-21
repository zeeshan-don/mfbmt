/**
 * A small in-process async mutex keyed by name.
 *
 * Used to make overlapping scheduler deliveries (QStash retries, concurrent
 * cron firings) safe within a single process. Cross-process protection comes
 * from the database-level leases/idempotency keys; this mutex prevents two
 * overlapping calls in the same runtime from racing past the DB checks.
 */
const locks = new Map<string, Promise<void>>();

export async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
  const previous = locks.get(key);
  if (previous) {
    // Another call is in flight; do not wait indefinitely — report not acquired
    // so the caller can skip (idempotent no-op) instead of piling up.
    return { acquired: false };
  }

  let resolve!: () => void;
  const gate = new Promise<void>((res) => {
    resolve = res;
  });
  locks.set(key, gate);

  try {
    const value = await fn();
    return { acquired: true, value };
  } finally {
    locks.delete(key);
    resolve();
  }
}

/** Test helper: clear all in-flight locks. */
export function resetMutexes(): void {
  locks.clear();
}
