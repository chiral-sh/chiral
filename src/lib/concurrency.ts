// Runs an async mapper over items with bounded concurrency, preserving input
// order in the result and matching Promise.all's reject-on-first-error
// semantics (does not wait for in-flight calls to settle before rejecting).

export function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit <= 0 || limit >= items.length) {
    return Promise.all(items.map((item, index) => fn(item, index)));
  }

  return new Promise<R[]>((resolve, reject) => {
    const results: R[] = new Array(items.length) as R[];
    let nextIndex = 0;
    let completed = 0;
    let rejected = false;

    if (items.length === 0) {
      resolve(results);
      return;
    }

    const runNext = () => {
      if (rejected) return;
      const index = nextIndex++;
      if (index >= items.length) return;

      fn(items[index], index)
        .then((result) => {
          if (rejected) return;
          results[index] = result;
          completed++;
          if (completed === items.length) {
            resolve(results);
          } else {
            runNext();
          }
        })
        .catch((err: unknown) => {
          if (rejected) return;
          rejected = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    };

    for (let i = 0; i < Math.min(limit, items.length); i++) {
      runNext();
    }
  });
}
