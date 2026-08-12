/** A small FIFO semaphore for keeping upstream request fan-out bounded. */
export interface Limiter {
  run<T>(fn: () => T | Promise<T>): Promise<T>;
}

/**
 * Run at most `concurrency` tasks at once. Queued tasks start in submission
 * order and always release their slot, including when they reject.
 */
export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active -= 1;
    queue.shift()?.();
  };

  const acquire = (): Promise<void> => new Promise((resolve) => {
    const start = () => {
      active += 1;
      resolve();
    };
    if (active < concurrency) start();
    else queue.push(start);
  });

  return {
    async run<T>(fn: () => T | Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
