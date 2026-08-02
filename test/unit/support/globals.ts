/**
 * Borrowing `globalThis`, and giving it back.
 *
 * Several modules under test read ambient globals directly — deliberately, on
 * the Stage 0 path, where an injected-globals parameter would cost bytes in the
 * one place bytes are budgeted. Testing them therefore means mutating process
 * state that every other test module shares.
 *
 * That is safe only while test files run one at a time, which is why the
 * restore logic lives here once rather than in three subtly different copies
 * (TST-15).
 *
 * > [!WARNING]
 * > Do not relax `singleThread` or `fileParallelism` in `vitest.config.ts`
 * > while any module imports this one. Vitest shares one `globalThis` across
 * > files in that configuration; the isolation here is temporal, not
 * > structural.
 *
 * Every helper returns a disposable, so callers can use `using` and cannot
 * forget the `finally`.
 */

type Descriptor = PropertyDescriptor | undefined;

const capture = (names: readonly string[]): (readonly [string, Descriptor])[] =>
  names.map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );

const restoreAll = (
  saved: readonly (readonly [string, Descriptor])[],
): void => {
  // Reverse order, so nested scopes unwind correctly even when two of them
  // touch the same name.
  for (let i = saved.length - 1; i >= 0; i--) {
    const entry = saved[i];
    if (entry === undefined) continue;
    const [name, descriptor] = entry;
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
};

/** A scope that puts `globalThis` back exactly as it found it. */
export interface GlobalScope extends Disposable {
  restore(): void;
}

const scopeFor = (
  saved: readonly (readonly [string, Descriptor])[],
  onRestore?: () => void,
): GlobalScope => {
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    onRestore?.();
    restoreAll(saved);
  };
  return { restore, [Symbol.dispose]: restore };
};

/** Define each `name` from an explicit descriptor for the life of the scope. */
export const withDescriptors = (
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
): GlobalScope => {
  const names = Object.keys(descriptors);
  const saved = capture(names);
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      ...descriptors[name],
    });
  }
  return scopeFor(saved);
};

/** Define each `name` as a plain data property for the life of the scope. */
export const withGlobals = (
  values: Readonly<Record<string, unknown>>,
  onRestore?: () => void,
): GlobalScope => {
  const names = Object.keys(values);
  const saved = capture(names);
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      value: values[name],
      configurable: true,
      writable: true,
    });
  }
  return scopeFor(saved, onRestore);
};

/**
 * Install accessors that throw on read.
 *
 * This is the realm shape observed in the wild — a sandboxing manager's proxy
 * or an anti-fingerprinting shim answers a plain read with an exception rather
 * than `undefined`, which `typeof` does not survive either.
 */
export const poisonGlobals = (
  ...names: readonly string[]
): GlobalScope => {
  const saved = capture(names);
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get: (): never => {
        throw new TypeError(
          `undefined is not an object (evaluating '${name}')`,
        );
      },
    });
  }
  return scopeFor(saved);
};
