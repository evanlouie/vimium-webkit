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

import {
  Array,
  Boolean,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  flow,
  pipe,
} from "effect";
import { FrameId } from "~/domain/FrameId.ts";
import { Dom } from "./Dom.ts";

/**
 * The frame identity, given again here.
 *
 * `domain/FrameId.ts` owns the brand, because the wire schemas decode into it.
 * A caller that asks the realm for its identity then needs only one import.
 */
export { FrameId };

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

export class RealmError extends Schema.TaggedError<RealmError>()("RealmError", {
  detail: Schema.String,
}) {}

/** How deep the wake walk goes. Ad-heavy pages nest without limit. */
const MAX_WAKE_DEPTH = 16;

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

const hexByte = (byte: number): string => byte.toString(16).padStart(2, "0");

const randomId = (): string =>
  pipe(
    crypto.getRandomValues(new Uint8Array(8)),
    Array.fromIterable,
    Array.map(hexByte),
    Array.join(""),
  );

/** The indexes from `0` to `count - 1`. */
const indexesBelow = (count: number): ReadonlyArray<number> =>
  Array.unfold(
    0,
    flow(
      Option.liftPredicate((index: number) => index < count),
      Option.map((index) => [index, index + 1] as const),
    ),
  );

/**
 * One frame directly inside `view`.
 *
 * A `WindowProxy` exposes its child frames only as indexed properties. There is
 * no method to call instead, so this is the one indexed read of the module. A
 * realm that refuses the read, or a frame that went away, gives no frame.
 */
const childFrame = (view: Window, index: number): Option.Option<Window> =>
  pipe(
    Result.try(() => view.frames[index]),
    Result.getSuccess,
    Option.flatMap(Option.fromNullishOr),
  );

/** The frames directly inside `view`. A realm that refuses the count has none. */
const childFrames = (view: Window): ReadonlyArray<Window> =>
  pipe(
    Result.try(() => view.frames.length),
    Result.map(indexesBelow),
    Result.getOrElse(() => Array.empty<number>()),
    Array.map((index) => childFrame(view, index)),
    Array.getSomes,
  );

/** `frame`, then every frame below it, when `frame` sits at `depth`. */
const withDescendants =
  (depth: number) =>
  (frame: Window): ReadonlyArray<Window> =>
    pipe(descendantFrames(frame, depth), Array.prepend(frame));

/** Every frame below `view`, each before its own frames, down to `MAX_WAKE_DEPTH`. */
const descendantFrames = (view: Window, depth: number): ReadonlyArray<Window> =>
  pipe(
    depth > MAX_WAKE_DEPTH,
    Boolean.match({
      onFalse: () => pipe(childFrames(view), Array.flatMap(withDescendants(depth + 1))),
      onTrue: () => Array.empty<Window>(),
    }),
  );

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

    /** Send the wake message to every descendant frame, at every depth. */
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

      const isLive = dom.probeOr(
        () => dom.window.navigator !== undefined && dom.window.document !== undefined,
        false,
      );

      const role = yield* dom.probeOr(
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
        FrameRole.Child(),
      );

      const postToDescendants = (message: unknown): Effect.Effect<void> =>
        Effect.sync(() => pipe(descendantFrames(dom.window, 0), Array.forEach(postTo(message))));

      const isAncestor = (source: unknown): Effect.Effect<boolean> =>
        dom.probeOr(
          () =>
            pipe(
              source,
              Option.fromNullishOr,
              Option.exists((frame) => frame === dom.window.parent || frame === dom.window.top),
            ),
          false,
        );

      return Realm.of({
        frameId: FrameId.make(randomId()),
        role,
        isLive,
        wakeDescendants: postToDescendants(WAKE_MESSAGE),
        askDescendantsToAnnounce: postToDescendants(ANNOUNCE_MESSAGE),
        isAncestor,
      });
    }),
  );
}
