/**
 * Cooperative scheduling primitives.
 *
 * `requestIdleCallback` is still unshipped in Safari (true as of 26.5), so
 * every idle-shaped piece of work in this codebase — hint detection above all —
 * has to be chunked by hand against an explicit time budget. Do not reach for
 * `requestIdleCallback` directly anywhere else.
 */

export interface IdleDeadline {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

/** Slice length for chunked work. Chosen to stay inside one 60 Hz frame. */
export const CHUNK_BUDGET_MS = 8;

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

interface NativeIdleWindow {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadline) => void,
    options?: { timeout?: number },
  ) => number;
}

export const hasNativeIdleCallback = (): boolean =>
  typeof (globalThis as NativeIdleWindow).requestIdleCallback === "function";

export interface ChunkedRunOptions {
  /** Time budget per slice. */
  readonly budgetMs?: number;
  /** Abort cooperatively; checked between slices and between items. */
  readonly signal?: AbortSignal;
  /** How many items to process before consulting the clock. */
  readonly checkEvery?: number;
}

export class AbortedError extends Error {
  constructor() {
    super("chunked work aborted");
    this.name = "AbortedError";
  }
}

/**
 * Map over `items` in time-boxed slices, yielding to the event loop between
 * them. Resolves with the accumulated non-`undefined` results.
 *
 * The `checkEvery` knob exists because `performance.now()` is itself
 * measurable when called once per element across thousands of elements.
 */
export const mapChunked = async <T, R>(
  items: readonly T[],
  transform: (item: T, index: number) => R | undefined,
  options: ChunkedRunOptions = {},
): Promise<R[]> => {
  const budget = options.budgetMs ?? CHUNK_BUDGET_MS;
  const checkEvery = options.checkEvery ?? 32;
  const out: R[] = [];
  let index = 0;

  while (index < items.length) {
    if (options.signal?.aborted) throw new AbortedError();
    const sliceStart = now();
    let sinceCheck = 0;

    while (index < items.length) {
      const item = items[index];
      if (item !== undefined) {
        const result = transform(item, index);
        if (result !== undefined) out.push(result);
      }
      index++;
      if (++sinceCheck >= checkEvery) {
        sinceCheck = 0;
        if (now() - sliceStart >= budget) break;
      }
    }

    if (index < items.length) {
      // Sequential by design: the whole point is to hand control back between
      // slices, which cannot be parallelised away.
      // oxlint-disable-next-line no-await-in-loop
      await yieldToEventLoop();
    }
  }

  return out;
};

/**
 * Hand control back to the browser.
 *
 * `MessageChannel` rather than `setTimeout(0)` because Safari, like every other
 * engine, clamps nested timeouts to 4 ms — which would triple the wall-clock
 * cost of a many-slice pass.
 */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

export const nextFrame = (): Promise<number> =>
  new Promise((resolve) => {
    requestAnimationFrame(resolve);
  });

/**
 * Coalesce calls into at most one per animation frame, keeping the most recent
 * arguments. Used for anything that reads layout in response to a burst of
 * events (scroll, resize, `visualViewport` changes).
 */
export const rafCoalesce = <A extends readonly unknown[]>(
  fn: (...args: A) => void,
): ((...args: A) => void) & { cancel: () => void } => {
  // `requestAnimationFrame`, not a timer: this handle really is a `number`.
  let handle: number | null = null;
  let pending: A | null = null;

  const wrapped = (...args: A): void => {
    pending = args;
    if (handle !== null) return;
    handle = requestAnimationFrame(() => {
      handle = null;
      const args2 = pending;
      pending = null;
      if (args2) fn(...args2);
    });
  };

  wrapped.cancel = (): void => {
    if (handle !== null) cancelAnimationFrame(handle);
    handle = null;
    pending = null;
  };

  return wrapped;
};

/** A promise that rejects after `ms`, for time-boxing cross-frame requests. */
export const timeout = (ms: number, label: string): Promise<never> =>
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

/** Resolve with `fallback` if `promise` has not settled within `ms`. */
export const withDeadline = async <T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
