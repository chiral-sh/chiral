import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../../../src/lib/concurrency.js';

function delay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const items = [30, 10, 20];
    const results = await mapWithConcurrency(items, 2, (item) => delay(item * 2, item));
    expect(results).toEqual([60, 20, 40]);
  });

  it('never runs more than limit calls in flight at once', async () => {
    const items = [10, 10, 10, 10, 10];
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(items, 2, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const result = await delay(item, item);
      inFlight--;
      return result;
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('rejects with the first error encountered', async () => {
    const items = [1, 2, 3];
    const err = new Error('boom');

    await expect(
      mapWithConcurrency(items, 2, async (item) => {
        if (item === 2) throw err;
        return delay(item, 10);
      }),
    ).rejects.toBe(err);
  });

  it('behaves like Promise.all when limit exceeds items.length', async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrency(items, 10, (item) => Promise.resolve(item * 10));
    expect(results).toEqual([10, 20, 30]);
  });

  it('returns empty array for empty input', async () => {
    const results = await mapWithConcurrency<number, number>([], 2, (item) =>
      Promise.resolve(item),
    );
    expect(results).toEqual([]);
  });
});
