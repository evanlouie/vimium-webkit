/**
 * Reads of globals we do not own.
 *
 * A userscript shares its realm with the page, with the browser's extensions,
 * and with the manager that injected it. Any of them can replace a global with
 * an accessor, and an accessor can *throw* where a missing API would merely be
 * `undefined`.
 *
 * This is not hypothetical. A Safari user reported `navigator` answering
 * `typeof "object"` and then throwing from the `userAgent` getter one line
 * later, which took the whole of Stage 1 down with it. Neither a `typeof` guard
 * nor `?.` survives that, because both still perform the read — only a `try`
 * does.
 *
 * So every read of such a global lives here, behind a function that answers
 * "not available" rather than throwing, and the build enforces it (§9.4, rule
 * `ambient-globals`). Two files are exempt and say why: `boot/stage0.ts`, which
 * may not import anything, and `platform/gm.ts`, which is the manager
 * chokepoint and probes its own bindings with `probe` below.
 */

/**
 * Run `read`, treating any failure as "not available".
 *
 * The fallback is the answer for both "it is not there" and "we could not find
 * out", because a caller can only act on the former.
 */
export const probe = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

/** The UA string, or `""` if it cannot be read. */
export const userAgent = (): string =>
  probe(() => {
    const ua: unknown = navigator.userAgent;
    return typeof ua === "string" ? ua : "";
  }, "");

/**
 * `navigator.clipboard.writeText`, already bound.
 *
 * Bound rather than handed back in two pieces because the caller has to invoke
 * it synchronously from the key handler: on WebKit the user activation is spent
 * by the first `await`.
 */
export const clipboardWriter = ():
  | ((text: string) => Promise<void>)
  | null =>
  probe(() => {
    const clipboard = navigator.clipboard;
    return typeof clipboard?.writeText === "function"
      ? clipboard.writeText.bind(clipboard)
      : null;
  }, null);

/** `navigator.clipboard.readText`, already bound. */
export const clipboardReader = (): (() => Promise<string>) | null =>
  probe(() => {
    const clipboard = navigator.clipboard;
    return typeof clipboard?.readText === "function"
      ? clipboard.readText.bind(clipboard)
      : null;
  }, null);

/** `navigator.storage`, or `null` if it is absent or unreadable. */
export const storageManager = (): StorageManager | null =>
  probe(() => (navigator.storage as StorageManager | undefined) ?? null, null);
