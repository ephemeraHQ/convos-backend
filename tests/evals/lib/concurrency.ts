/**
 * Bounded-parallelism map. Runs `fn` over `items` with at most `limit` in
 * flight, preserving input order in the results. `limit` is clamped to >= 1 so a
 * misconfigured concurrency of 0 can't silently no-op the whole run.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: workers }, () =>
      (async () => {
        while (cursor < items.length) {
          const i = cursor++;
          results[i] = await fn(items[i], i);
        }
      })(),
    ),
  );
  return results;
}
