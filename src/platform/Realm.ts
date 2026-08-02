/**
 * What this frame is.
 *
 * One realm holds one instance of the application. This service answers the
 * three questions that every other service asks about the realm it runs in: is
 * it usable, is it the top frame, and what is its identity on the wire.
 *
 * The obvious spelling of the top-frame test, `top === self`, is a trap. In a
 * realm that hides those bindings it reads `undefined === undefined` and
 * promotes every frame to top. This service demands a real object instead.
 * Absence cannot satisfy that test.
 */

import { Context, Effect, Layer, Schema } from "effect";
import { Dom } from "./Dom.ts";

/** A frame identity. Random, per frame, and never reused. */
export const FrameId = Schema.String.pipe(Schema.brand("FrameId"));
export type FrameId = typeof FrameId.Type;

export class RealmError extends Schema.TaggedErrorClass<RealmError>()(
  "RealmError",
  { detail: Schema.String },
) {}

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

const randomId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

export class Realm extends Context.Service<Realm, {
  /** This frame's identity on the frame bus. */
  readonly frameId: FrameId;
  /** True when this frame is the top document of its tab. */
  readonly isTop: boolean;
  /** True when the realm has the globals that the application needs. */
  readonly isLive: boolean;

  /** Send the wake message to every descendant frame, at every depth. */
  readonly wakeDescendants: Effect.Effect<void>;

  /** Ask every descendant that is already running to announce itself. */
  readonly askDescendantsToAnnounce: Effect.Effect<void>;

  /** True when `source` is this frame's parent or the top frame. */
  readonly isAncestor: (source: unknown) => Effect.Effect<boolean>;
}>()("vimium/platform/Realm") {
  static readonly layer: Layer.Layer<Realm, never, Dom> = Layer.effect(
    Realm,
    Effect.gen(function*() {
      const dom = yield* Dom;

      const isLive = yield* dom.probeOr(
        () =>
          dom.window.navigator !== undefined &&
          dom.window.document !== undefined,
        false,
      );

      const isTop = yield* dom.probeOr(() => {
        const scope = dom.window as { top?: unknown; self?: unknown };
        const top = scope.top;
        return typeof top === "object" && top !== null && top === scope.self;
      }, false);

      const postToDescendants = (message: unknown): Effect.Effect<void> =>
        Effect.sync(() => {
          const visit = (view: Window, depth: number): void => {
            if (depth > MAX_WAKE_DEPTH) return;
            let count = 0;
            try {
              count = view.frames.length;
            } catch {
              return;
            }
            for (let index = 0; index < count; index++) {
              let child: Window | undefined;
              try {
                child = view.frames[index];
              } catch {
                continue;
              }
              if (child === undefined) continue;
              try {
                child.postMessage(message, "*");
              } catch {
                // A cross-origin frame can refuse. There is no other route.
              }
              visit(child, depth + 1);
            }
          };
          visit(dom.window, 0);
        });

      const isAncestor = (source: unknown): Effect.Effect<boolean> =>
        dom.probeOr(() => {
          if (source === null || source === undefined) return false;
          const scope = dom.window as { parent?: unknown; top?: unknown };
          return source === scope.parent || source === scope.top;
        }, false);

      return Realm.of({
        frameId: randomId() as FrameId,
        isTop,
        isLive,
        wakeDescendants: postToDescendants(WAKE_MESSAGE),
        askDescendantsToAnnounce: postToDescendants(ANNOUNCE_MESSAGE),
        isAncestor,
      });
    }),
  );
}
