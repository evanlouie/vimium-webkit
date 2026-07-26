/**
 * Stage 0: the always-on shim.
 *
 * Runs in **every frame**, on **every page**, whether or not the user ever
 * presses a key. With 5–20 frames on a typical page this is the classic
 * userscript CPU sink, so the budget here is brutal: no DOM writes, no
 * `getComputedStyle`, no storage access, no Zod, no neverthrow, and no imports
 * beyond this file. Target: under 1 ms and under 5 KB (§5.2, CI invariant 3).
 *
 * Everything else is deferred to Stage 1, which is only reached when the user
 * actually asks for something.
 *
 * Two WebKit realities shape this design:
 *
 * - `@run-at document-start` is unreliable (§7.1) — both a Safari platform bug
 *   and an unavoidable async hop in the Safari-native managers. We must assume
 *   we booted *late*, possibly after the page registered its own key
 *   listeners, and be correct anyway.
 * - Safari's back/forward cache restores a page without re-running scripts, so
 *   `pageshow`/`pagehide` are the lifecycle events that matter. `unload` is not
 *   used anywhere in this codebase: Safari bfcaches pages that have `unload`
 *   handlers and then never fires them.
 */

/** Guards against a manager injecting us twice into the same realm. */
const GUARD = Symbol.for("vimium-webkit.stage0");

/**
 * Keystrokes held while Stage 1 hydrates.
 *
 * Upstream calls the equivalent mode `CacheAllKeydownEvents`. Buffering is
 * unavoidable: settings hydration is asynchronous on every manager, because
 * `GM.getValue` is promise-only on quoid.
 */
const MAX_BUFFERED_KEYS = 16;

/** Message a top frame sends to wake a subframe that is still at Stage 0. */
export const WAKE_MESSAGE = "vimium-webkit:wake";

/**
 * Is this realm one we can actually serve?
 *
 * A userscript does not own its globals. A sandboxing manager can hand us a
 * proxied `window`, an extension can replace `navigator` with an accessor, and
 * either can make a plain read *throw* rather than return `undefined` — which
 * is why this is a `try` and not a pair of `typeof` guards. Stage 0 runs at
 * `document-start` in every frame, so an exception escaping here is an
 * exception thrown into the page: the one failure mode this project rules out
 * unconditionally (G3).
 */
export const isLiveRealm = (): boolean => {
  try {
    return typeof navigator !== "undefined" && typeof document !== "undefined";
  } catch {
    return false;
  }
};

/**
 * Are we the top frame?
 *
 * The obvious spelling, `top === self`, is a trap: in any realm that hides or
 * has torn down those bindings it reads `undefined === undefined` and promotes
 * every frame to "top", which is how a frame we cannot serve ends up scheduling
 * the idle wake-up and dragging Stage 1 in behind it. Demanding a real object
 * costs nothing and cannot be satisfied by absence.
 */
export const isTopFrame = (): boolean => {
  if (!isLiveRealm()) return false;
  try {
    const scope = globalThis as { top?: unknown; self?: unknown };
    const top = scope.top;
    return typeof top === "object" && top !== null && top === scope.self;
  } catch {
    return false;
  }
};

export type Stage0KeyHandler = (event: KeyboardEvent) => void;

export type ActivationReason = "keydown" | "wake" | "idle";

export interface Stage0 {
  /** Keys pressed before Stage 1 was ready, oldest first. */
  drainBuffer(): readonly KeyboardEvent[];
  /** Hand keyboard events to Stage 1 from here on. */
  adopt(handler: Stage0KeyHandler): void;
  /** Re-register listeners; called after a bfcache restore. */
  rearm(): void;
  dispose(): void;
}

export interface Stage0Options {
  /**
   * Called once, when something suggests the user wants us.
   *
   * May be called from a keydown task, so anything activation-sensitive
   * downstream must not `await` before acting.
   */
  onActivate(reason: ActivationReason): void;
  /** Called on `pagehide`; `persisted` means the page entered the bfcache. */
  onTeardown?(persisted: boolean): void;
  /** Called on a bfcache restore. */
  onRestore?(): void;
}

interface GuardedGlobal {
  [GUARD]?: Stage0;
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target instanceof HTMLElement && target.isContentEditable;
};

/**
 * Keys that must not wake us.
 *
 * A page that is merely being typed into should never pay for Stage 1. The
 * editable check is deliberately structural rather than a `getComputedStyle`
 * call — this runs on every keystroke in every frame.
 */
const isUninteresting = (event: KeyboardEvent): boolean => {
  if (event.isComposing || event.keyCode === 229) return true;
  const key = event.key;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
    return true;
  }
  return isEditableTarget(event.target);
};

class Stage0Impl implements Stage0 {
  readonly #options: Stage0Options;
  readonly #buffer: KeyboardEvent[] = [];

  #handler: Stage0KeyHandler | null = null;
  #activated = false;
  #idleTimer: number | null = null;
  #disposed = false;

  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (this.#handler !== null) {
      this.#handler(event);
      return;
    }
    if (isUninteresting(event)) return;
    if (this.#buffer.length < MAX_BUFFERED_KEYS) this.#buffer.push(event);
    this.#activate("keydown");
  };

  readonly #onKeyup = (event: KeyboardEvent): void => {
    this.#handler?.(event);
  };

  readonly #onMessage = (event: MessageEvent): void => {
    if (event.data === WAKE_MESSAGE) this.#activate("wake");
  };

  readonly #onPageHide = (event: PageTransitionEvent): void => {
    // `persisted` distinguishes "entering the bfcache" from "actually leaving".
    // Tearing down state on the former would break the restore.
    this.#options.onTeardown?.(event.persisted);
  };

  readonly #onPageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    this.rearm();
    this.#options.onRestore?.();
  };

  constructor(options: Stage0Options) {
    this.#options = options;
    this.rearm();

    // The top frame warms up on its own so the first keystroke feels instant;
    // subframes stay at Stage 0 until a key lands in them or the coordinator
    // wakes them for a hint round (§5.2: "do not build UI in Stage 0").
    if (isTopFrame()) {
      this.#idleTimer = setTimeout(() => {
        this.#idleTimer = null;
        this.#activate("idle");
      }, 1200);
    }
  }

  /**
   * (Re-)attach listeners.
   *
   * Capture phase on `globalThis`, so we see keys before the page's own
   * handlers regardless of who registered first — and re-attached on `pageshow`
   * because a bfcache restore can leave us detached.
   *
   * No `#armed` latch: the constructor sets it, nothing ever cleared it, and
   * every later call therefore returned immediately, which made the documented
   * bfcache re-arm path a permanent no-op (FRM-09). A latch is not needed
   * anyway — `addEventListener` with the same type, callback and capture flag
   * is specified to be a no-op, so re-arming cannot double-register.
   */
  rearm(): void {
    if (this.#disposed) return;
    globalThis.addEventListener("keydown", this.#onKeydown, true);
    globalThis.addEventListener("keyup", this.#onKeyup, true);
    globalThis.addEventListener("message", this.#onMessage);
    globalThis.addEventListener("pagehide", this.#onPageHide);
    globalThis.addEventListener("pageshow", this.#onPageShow);
  }

  #activate(reason: ActivationReason): void {
    if (this.#activated) return;
    this.#activated = true;
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    // The realm may have gone away since we booted — a frame removed while a
    // timer was pending. Nothing Stage 1 builds could be seen or used there.
    if (!isLiveRealm()) return;
    this.#options.onActivate(reason);
  }

  drainBuffer(): readonly KeyboardEvent[] {
    return this.#buffer.splice(0);
  }

  adopt(handler: Stage0KeyHandler): void {
    this.#handler = handler;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    globalThis.removeEventListener("keydown", this.#onKeydown, true);
    globalThis.removeEventListener("keyup", this.#onKeyup, true);
    globalThis.removeEventListener("message", this.#onMessage);
    globalThis.removeEventListener("pagehide", this.#onPageHide);
    globalThis.removeEventListener("pageshow", this.#onPageShow);
  }
}

/**
 * Install Stage 0, or return `null` if there is nothing to install into.
 *
 * `null` means either that this realm already has an instance, or that it is
 * one we cannot serve at all (see `isLiveRealm`).
 *
 * The guard is a `Symbol.for` on the global rather than a property name: it
 * survives bundling, cannot collide with page state, and is stable across our
 * own versions if a user ends up with two copies installed.
 */
export const bootStage0 = (options: Stage0Options): Stage0 | null => {
  if (!isLiveRealm()) return null;
  const scope = globalThis as unknown as GuardedGlobal;
  if (scope[GUARD] !== undefined) return null;
  const stage0 = new Stage0Impl(options);
  scope[GUARD] = stage0;
  return stage0;
};

/** Wake every subframe. Used before a cross-frame hint round. */
export const wakeSubframes = (): void => {
  for (let index = 0; index < globalThis.frames.length; index++) {
    try {
      globalThis.frames[index]?.postMessage(WAKE_MESSAGE, "*");
    } catch {
      // A cross-origin frame may refuse; there is nothing useful to do.
    }
  }
};
