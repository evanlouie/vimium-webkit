/**
 * Frame discovery and the `MessagePort` registry (IMPLEMENTATION_PLAN.md §6.5).
 *
 * Adapted from Vimium's frame bookkeeping in
 * `background_scripts/main.js` (`registerFrame` / `unregisterFrame` /
 * `HintCoordinator`'s frame set), reimplemented against `postMessage` because a
 * userscript has no background page to hold the map.
 *
 * Two jobs:
 *
 * 1. Prove that a `HELLO` came from a window that is actually in our frames
 *    tree. `event.source === window.frames[i]` compares window *identities* and
 *    works cross-origin, which is the only cheap identity check we get.
 * 2. Keep `frameId -> MessagePort` and reap frames that have gone away.
 *
 * Reaping is harder than it looks: posting to a `MessagePort` whose other end
 * was garbage-collected with its document does **not** throw, so "the post
 * failed" is not a signal we actually receive. The reliable signal is the
 * frames tree itself — a record whose source window is no longer reachable from
 * the root is dead. That sweep runs on every roster read, which is cheap and
 * happens exactly when it matters.
 */

import { err, ok, type Result } from "neverthrow";
import type { FrameId } from "~/core/context.ts";
import { formatFrameId, type FrameMessage } from "./protocol.ts";

/**
 * Depth and node ceilings for the frames-tree walk.
 *
 * Ad-heavy pages nest frames absurdly, and this walk runs on the keystroke path
 * (`knownFrames()` is consulted every time hints activate). Bounded work beats
 * a correct-but-unbounded traversal.
 */
const MAX_TREE_DEPTH = 16;
const MAX_TREE_NODES = 512;

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type PostResult = Result<void, unknown>;

/**
 * One duplex link to a frame.
 *
 * Abstracted over `MessagePort` so the top frame can talk to *itself* through
 * the same code path as every other frame. Special-casing "am I the
 * coordinator?" at each of a dozen call sites is how this kind of module rots.
 */
export interface FrameChannel {
  post(message: FrameMessage): PostResult;
  close(): void;
}

/** Wraps a transferred `MessagePort`. The only real I/O boundary in here. */
export const messagePortChannel = (port: MessagePort): FrameChannel => {
  let closed = false;
  return {
    post: (message: FrameMessage): PostResult => {
      if (closed) return err(new Error("channel closed"));
      try {
        port.postMessage(message);
        return ok(undefined);
      } catch (cause: unknown) {
        // Structured-clone failures land here. Our payloads are plain JSON, so
        // in practice this only fires on an already-neutered port.
        return err(cause);
      }
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      port.close();
    },
  };
};

/**
 * An in-process channel, used for the coordinator's own frame.
 *
 * Delivery is deferred to a microtask on purpose: a real `MessagePort` is
 * always async, and letting the top frame observe synchronous delivery would
 * bake a re-entrancy assumption into the coordinator that no other frame
 * satisfies.
 */
export const loopbackChannel = (
  deliver: (message: FrameMessage) => void,
): FrameChannel => {
  let closed = false;
  return {
    post: (message: FrameMessage): PostResult => {
      if (closed) return err(new Error("channel closed"));
      queueMicrotask(() => {
        if (!closed) deliver(message);
      });
      return ok(undefined);
    },
    close: (): void => {
      closed = true;
    },
  };
};

// ---------------------------------------------------------------------------
// Frames tree
// ---------------------------------------------------------------------------

/**
 * Every window reachable from `root`, in document order.
 *
 * `window.frames.length` and `window.frames[i]` are readable cross-origin — one
 * of the very few things that are — so this works even when every child is a
 * different origin. Frames we can never talk to (CSP-`sandbox`ed, `about:blank`
 * below Safari 18.4) still appear here; they simply never send a `HELLO`, which
 * is exactly the "absent, not blocking" behaviour we want.
 */
export const collectFrameWindows = (root: Window): readonly Window[] => {
  const out: Window[] = [];

  const walk = (parent: Window, depth: number): void => {
    if (depth >= MAX_TREE_DEPTH || out.length >= MAX_TREE_NODES) return;
    let count = 0;
    try {
      count = parent.frames.length;
    } catch {
      // A frame can become inaccessible mid-walk (detached during layout).
      return;
    }
    for (let index = 0; index < count; index++) {
      if (out.length >= MAX_TREE_NODES) return;
      let child: Window | undefined;
      try {
        child = parent.frames[index];
      } catch {
        continue;
      }
      if (child === undefined) continue;
      out.push(child);
      walk(child, depth + 1);
    }
  };

  walk(root, 0);
  return out;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface FrameRecord {
  readonly frameId: FrameId;
  readonly channel: FrameChannel;
  /** `null` for the coordinator's own loopback record, which is never reaped. */
  readonly source: Window | null;
  readonly registeredAt: number;
}

export interface FrameRegistryOptions {
  /**
   * The window to walk for identity checks. `null` in environments with no DOM
   * (unit tests), which disables the tree checks rather than crashing.
   */
  readonly root: Window | null;
  /** Fired whenever the set of live frames changes, so the roster can be republished. */
  readonly onChange?: () => void;
}

/**
 * `frameId -> channel`, plus document ordering and liveness.
 *
 * Registrations are accepted at *any* time. `document-start` is unreliable on
 * WebKit and iframes are inserted long after load, so "the frame list" is never
 * final and nothing here may treat it as such.
 */
export class FrameRegistry {
  readonly #records = new Map<FrameId, FrameRecord>();
  readonly #root: Window | null;
  readonly #onChange: (() => void) | undefined;
  #nextIndex = 0;

  constructor(options: FrameRegistryOptions) {
    this.#root = options.root;
    this.#onChange = options.onChange;
  }

  get size(): number {
    return this.#records.size;
  }

  /** Is `source` a window in our frames tree? The `HELLO` admission check. */
  isKnownWindow(source: unknown): source is Window {
    if (this.#root === null || source === null || source === undefined) {
      return false;
    }
    if (source === this.#root) return true;
    for (const candidate of collectFrameWindows(this.#root)) {
      if (candidate === source) return true;
    }
    return false;
  }

  /**
   * Add a frame, or re-key an existing one.
   *
   * A window that registers twice is a reload or a bfcache restore, not a new
   * frame, so it keeps its id: the roster stays stable and reload-happy ad
   * frames cannot walk the id counter to infinity.
   */
  register(channel: FrameChannel, source: Window | null): FrameRecord {
    const existing = source === null ? undefined : this.#findBySource(source);
    const frameId = existing?.frameId ?? formatFrameId(this.#nextIndex++);
    existing?.channel.close();

    const record: FrameRecord = {
      frameId,
      channel,
      source,
      registeredAt: Date.now(),
    };
    this.#records.set(frameId, record);
    this.#onChange?.();
    return record;
  }

  get(frameId: FrameId): FrameRecord | undefined {
    return this.#records.get(frameId);
  }

  has(frameId: FrameId): boolean {
    return this.#records.has(frameId);
  }

  remove(frameId: FrameId): boolean {
    const record = this.#records.get(frameId);
    if (record === undefined) return false;
    record.channel.close();
    this.#records.delete(frameId);
    this.#onChange?.();
    return true;
  }

  /**
   * Live frame ids in document order.
   *
   * Sweeps first, so callers never see a frame that has been removed from the
   * DOM. Ordering is by position in the frames tree rather than by registration
   * order, because `gf` promises "the next frame down the page", not "the next
   * frame that happened to boot".
   */
  ids(): readonly FrameId[] {
    this.sweep();
    const tree = this.#root === null ? [] : collectFrameWindows(this.#root);
    const position = new Map<Window, number>();
    tree.forEach((frame, index) => position.set(frame, index));

    return [...this.#records.values()]
      .map((record) => ({
        frameId: record.frameId,
        // The loopback record has no window and is always the root document.
        order: record.source === null
          ? -1
          : position.get(record.source) ?? Number.MAX_SAFE_INTEGER,
        registeredAt: record.registeredAt,
      }))
      .sort((a, b) =>
        a.order !== b.order
          ? a.order - b.order
          : (a.frameId < b.frameId ? -1 : 1)
      )
      .map((entry) => entry.frameId);
  }

  /** Drop records whose window has left the frames tree. */
  sweep(): void {
    if (this.#root === null) return;
    const live = new Set<Window>(collectFrameWindows(this.#root));
    live.add(this.#root);

    let changed = false;
    for (const record of [...this.#records.values()]) {
      if (record.source === null || live.has(record.source)) continue;
      record.channel.close();
      this.#records.delete(record.frameId);
      changed = true;
    }
    if (changed) this.#onChange?.();
  }

  /** Send to one frame. Returns `false` and reaps the record if the post fails. */
  post(frameId: FrameId, message: FrameMessage): boolean {
    const record = this.#records.get(frameId);
    if (record === undefined) return false;
    if (record.channel.post(message).isOk()) return true;
    this.remove(frameId);
    return false;
  }

  /**
   * Send a per-recipient payload to every live frame.
   *
   * Per-recipient rather than one shared message because `ACTIVATE` strips each
   * frame's own descriptors from the copy it receives. Returning `null` from
   * `build` skips that frame.
   */
  broadcast(build: (frameId: FrameId) => FrameMessage | null): void {
    for (const frameId of this.ids()) {
      const message = build(frameId);
      if (message !== null) this.post(frameId, message);
    }
  }

  dispose(): void {
    for (const record of this.#records.values()) record.channel.close();
    this.#records.clear();
  }

  #findBySource(source: Window): FrameRecord | undefined {
    for (const record of this.#records.values()) {
      if (record.source === source) return record;
    }
    return undefined;
  }
}
