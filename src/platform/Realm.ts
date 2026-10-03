/**
 * What this frame is.
 *
 * One realm holds one instance of the application. This service answers the
 * three questions that every other service asks about the realm it runs in: is
 * it usable, is it the top frame or a child frame, and what is its identity on
 * the wire.
 *
 * The obvious spelling of the top-frame test, `top === self`, is a trap. In a
 * realm that hides those bindings it reads `undefined === undefined` and
 * promotes every frame to top. This service demands a real object instead.
 * Absence cannot satisfy that test.
 */

import { Array, Context, Data, Effect, Layer, Option, Predicate, Result, pipe } from "effect";
import { Hex } from "effect/encoding";
import { constFalse } from "effect/Function";
import { FrameId } from "~/domain/FrameId.ts";
import { Dom } from "./Dom.ts";

/** A variant with no fields. The type `{}` would mean any value that is not nullish. */
type NoFields = Record<never, never>;

/**
 * Where this frame sits in the frames tree.
 *
 * The top frame is the top document of its tab. It coordinates the frame
 * session, and its URL decides the exclusion verdict of the page. Every other
 * frame is a child, which joins the session of the top frame. Only the place in
 * the frames tree decides the role.
 */
export type FrameRole = Data.TaggedEnum<{
  Top: NoFields;
  Child: NoFields;
}>;

export const FrameRole = Data.taggedEnum<FrameRole>();

/**
 * The message that starts a frame that has not started yet.
 *
 * It is structured, and the receiver checks `event.source` before it acts. A
 * bare string could be posted by any page to every frame that it can reach,
 * which would let the page force a full start in each of them.
 */
export const WAKE_MESSAGE = {
  magic: "vimium-webkit/frames",
  v: 1,
  kind: "WAKE",
} as const;

/**
 * The message that asks a frame that is *already* running to announce itself.
 *
 * It is not the wake message, and the difference is the whole point. The
 * coordinator sweeps the frames tree when it starts, because a frame that
 * started before its listener existed hears nothing. A sweep with the wake
 * message would build the whole application in every frame of the page, which
 * is the cost that the guard exists to avoid. The guard ignores this message.
 */
export const ANNOUNCE_MESSAGE = {
  magic: "vimium-webkit/frames",
  v: 1,
  kind: "ANNOUNCE",
} as const;

/**
 * Random bytes from the platform, in lowercase hexadecimal.
 *
 * It throws in a realm with no random source. A caller that can go on without
 * one reads it through `Dom.probeOrElse`.
 */
export const randomHex = (bytes: number): string =>
  Hex.encode(crypto.getRandomValues(new Uint8Array(bytes)));

/**
 * The ceilings for the walk of the frames tree.
 *
 * A page with many advertisements nests frames without limit, and the
 * coordinator walks the tree whenever it reads the roster. Bounded work is
 * better than a walk that is complete but has no limit.
 */
const MAX_TREE_DEPTH = 16;
const MAX_TREE_NODES = 512;

/**
 * Every window below `root`, each before its own frames, in document order.
 *
 * `window.frames.length` and `window.frames[index]` are readable across
 * origins, which few things are, so this walk works when every child has a
 * different origin. A frame that we can never talk to is in this list as well.
 * It simply never sends a `HELLO`, which is the "absent, and not blocking"
 * behaviour that we want.
 *
 * The root itself is not in the list. The coordinator once treated its own
 * window as known, and a page could then post itself a `HELLO` and be admitted
 * to the session as a frame of its own.
 *
 * This is an imperative loop on purpose. The coordinator walks the tree for
 * every message that it routes, and a keystroke that a hint round relays is
 * one of those, so the walk runs inside a `keydown` listener. A throwaway
 * benchmark on fake frame trees measured the loop at 0.4 µs for 20 frames and
 * 5.6 µs for 512 frames. The fastest version built from `Array` or `Iterable`
 * stages, with a `Result.try` for each read, took 28 µs and 760 µs.
 */
export const descendantFrames = (root: Window): ReadonlyArray<Window> => {
  const out: Window[] = [];

  const walk = (parent: Window, depth: number): void => {
    if (depth >= MAX_TREE_DEPTH || out.length >= MAX_TREE_NODES) return;
    let count = 0;
    try {
      count = parent.frames.length;
    } catch {
      // A frame can become unreachable during the walk, if the page detaches
      // it while the browser lays the page out.
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

/**
 * Post to one frame.
 *
 * A cross-origin frame can refuse, and there is no other route, so the refusal
 * is dropped.
 */
const postTo =
  (message: unknown) =>
  (frame: Window): void => {
    Result.try(() => {
      frame.postMessage(message, "*");
    });
  };

export class Realm extends Context.Service<
  Realm,
  {
    /** This frame's identity on the frame bus. */
    readonly frameId: FrameId;
    /** Whether this frame is the top document of its tab, or a frame inside it. */
    readonly role: FrameRole;
    /**
     * True when the realm still has the globals that the application needs.
     *
     * It reads the globals each time it runs. A frame can go away after the
     * layer was built, while a timer of the guard is still pending.
     */
    readonly isLive: Effect.Effect<boolean>;

    /** Send the wake message to every descendant frame that `descendantFrames` reaches. */
    readonly wakeDescendants: Effect.Effect<void>;

    /** Ask every descendant that is already running to announce itself. */
    readonly askDescendantsToAnnounce: Effect.Effect<void>;

    /** True when `source` is this frame's parent or the top frame. */
    readonly isAncestor: (source: unknown) => Effect.Effect<boolean>;
  }
>()("vimium/platform/Realm") {
  static readonly layer: Layer.Layer<Realm, never, Dom> = Layer.effect(
    Realm,
    Effect.gen(function* () {
      const dom = yield* Dom;

      const isLive = dom.probeOrElse(
        () => dom.window.navigator !== undefined && dom.window.document !== undefined,
        constFalse,
      );

      const role = yield* dom.probeOrElse(
        () =>
          pipe(
            dom.window.top,
            Option.liftPredicate(Predicate.isObjectKeyword),
            Option.filter((top) => top === dom.window.self),
            Option.match({
              onNone: () => FrameRole.Child(),
              onSome: () => FrameRole.Top(),
            }),
          ),
        () => FrameRole.Child(),
      );

      const postToDescendants = (message: unknown): Effect.Effect<void> =>
        Effect.sync(() => pipe(descendantFrames(dom.window), Array.forEach(postTo(message))));

      const isAncestor = (source: unknown): Effect.Effect<boolean> =>
        dom.probeOrElse(
          () =>
            pipe(
              source,
              Option.fromNullishOr,
              Option.exists((frame) => frame === dom.window.parent || frame === dom.window.top),
            ),
          constFalse,
        );

      return Realm.of({
        frameId: FrameId.make(randomHex(8)),
        role,
        isLive,
        wakeDescendants: postToDescendants(WAKE_MESSAGE),
        askDescendantsToAnnounce: postToDescendants(ANNOUNCE_MESSAGE),
        isAncestor,
      });
    }),
  );
}
