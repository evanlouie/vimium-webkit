/**
 * The application protocol on top of the frame bus.
 *
 * `FrameBus` moves a message. This service gives the meaning of the messages
 * that every frame needs: which frame has the focus, what the exclusion verdict
 * of the page is, and when the settings of the top frame reach storage. It is
 * the only user of the bus that every build has.
 *
 * Two rules from the earlier code, which cost real reviews to find:
 *
 * - **Settings never come over the wire.** A `SETTINGS` message carries
 *   nothing. Settings used to travel with it, which made the protocol a route
 *   to push a CSS string, a search template and a key-mapping source into every
 *   frame of a page, and made the handshake a route to take the exclusion
 *   patterns, the mappings and the engine list of the user out of the top
 *   frame. A push is a prompt to read our own storage again, and it is not a
 *   source of truth. The top frame sends it only once its settings reach
 *   storage, because a frame that reads earlier finds the old settings.
 * - **A child frame does not decide its own verdict.** Upstream Vimium resolves
 *   an exclusion against `sender.tab.url`, which is the URL of the top frame.
 *   Without that, a rule that the user wrote for a page would stop applying
 *   inside the frames of that page, and an excluded page would still have us
 *   live inside its third-party frames. `Exclusions` owns the verdict. A child
 *   frame hears the top frame through `TopFrameVerdict`, which this file gives.
 *
 * The hint protocol travels on the same bus, and it is not here. The hints
 * service answers `COLLECT_HINTS` and the other hint kinds for itself, with
 * `FrameBus.serve`. This file must not import anything from `src/features/`.
 */

import { Array, Boolean, Context, Effect, Filter, Layer, Option, Ref, Stream, pipe } from "effect";
import type { EffectiveRule } from "~/domain/Exclusion.ts";
import { isKind } from "~/domain/FrameMessage.ts";
import { Exclusions, knownRule, TopFrameVerdict } from "~/core/Exclusions.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { Dom } from "~/platform/Dom.ts";
import type { FrameId } from "~/domain/FrameId.ts";
import { FrameRole } from "~/platform/Realm.ts";
import {
  FrameBus,
  type FrameError,
  type InboundMessage,
  REQUEST_DEADLINE,
  toFrame,
  toTop,
} from "./Bus.ts";

/** Read the verdict out of the answer of the top frame. */
const verdictIn = (inbound: InboundMessage): Option.Option<EffectiveRule> =>
  pipe(
    inbound.message,
    Option.liftPredicate(isKind("EXCLUSION_RESULT")),
    Option.map(({ exclusion }) => exclusion),
  );

/** Where the cursor stands in `frames`. A cursor on no known frame stands on the first. */
const cursorIndex = (frames: ReadonlyArray<FrameId>, cursor: Option.Option<FrameId>): number =>
  pipe(
    cursor,
    Option.flatMap((focused) =>
      pipe(
        frames,
        Array.findFirstIndex((frame) => frame === focused),
      ),
    ),
    Option.getOrElse(() => 0),
  );

/**
 * The frame that takes the focus next, in document order and around the end.
 *
 * One frame alone has nowhere to send the focus.
 */
const nextFrame = (
  frames: ReadonlyArray<FrameId>,
  cursor: Option.Option<FrameId>,
  direction: 1 | -1,
): Option.Option<FrameId> =>
  pipe(
    frames,
    Option.liftPredicate((known) => known.length >= 2),
    Option.flatMap((known) =>
      pipe(
        known,
        Array.get((cursorIndex(known, cursor) + direction + known.length) % known.length),
      ),
    ),
  );

/**
 * The verdict of the top frame, as a child frame hears it over the bus.
 *
 * A child frame can ask only once it is admitted. The bus refuses every
 * request until the handshake ends, so the question waits for the admission
 * first. A frame that the deadline leaves outside the session gets no answer.
 */
export const topFrameVerdictLayer: Layer.Layer<TopFrameVerdict, never, FrameBus> = Layer.effect(
  TopFrameVerdict,
  Effect.gen(function* () {
    const bus = yield* FrameBus;

    const ask = pipe(
      bus.ready,
      Effect.flatMap(
        Boolean.match({
          onFalse: () => Effect.succeedNone,
          onTrue: () =>
            pipe(
              bus.request(toTop, { kind: "EXCLUSION_REQUEST" }, verdictIn, REQUEST_DEADLINE),
              Effect.option,
            ),
        }),
      ),
    );

    return TopFrameVerdict.of({
      ask,
      onPush: (adopt) =>
        bus.serve("VERDICT", ({ message }) =>
          pipe(adopt(message.exclusion), Effect.as(Option.none())),
        ),
    });
  }),
);

export class FrameLink extends Context.Service<
  FrameLink,
  {
    /** Move the focus one frame along document order. This is `gf` and `gF`. */
    readonly focusFrame: (direction: 1 | -1) => Effect.Effect<void, FrameError>;
  }
>()("vimium/frames/FrameLink") {
  static readonly layer: Layer.Layer<
    FrameLink,
    never,
    FrameBus | Exclusions | Settings | Report | Dom
  > = Layer.effect(
    FrameLink,
    Effect.gen(function* () {
      const bus = yield* FrameBus;
      const exclusions = yield* Exclusions;
      const settings = yield* Settings;
      const report = yield* Report;
      const dom = yield* Dom;

      /** The frame that the focus cursor points at. The top frame keeps it. */
      const focusedRef = yield* Ref.make(Option.none<FrameId>());

      /** Tell every frame the verdict that the top frame took. */
      const pushVerdict = (rule: EffectiveRule): Effect.Effect<void> =>
        pipe(bus.broadcast({ kind: "VERDICT", exclusion: rule }), Effect.ignore);

      /** Tell every frame to read its own storage again. */
      const pushSettings = pipe(bus.broadcast({ kind: "SETTINGS" }), Effect.ignore);

      /** Point the cursor at one frame, and give that frame the focus. */
      const focus = Effect.fnUntraced(function* (frameId: FrameId) {
        yield* pipe(focusedRef, Ref.set(Option.some(frameId)));
        yield* pipe(bus.send(toFrame(frameId), { kind: "TAKE_FOCUS" }), Effect.ignore);
      });

      /**
       * Give the focus to the next frame in document order.
       *
       * The cursor follows the `FOCUSED` messages, so `gf` continues from the
       * frame that the user is in, and not from where the cursor last stopped.
       */
      const elect = Effect.fn("FrameLink.elect")(function* (direction: 1 | -1) {
        const frames = yield* bus.peers;
        const cursor = yield* Ref.get(focusedRef);
        yield* pipe(
          nextFrame(frames, cursor, direction),
          Option.match({
            onNone: () => Effect.void,
            onSome: focus,
          }),
        );
      });

      /** Take the focus, and tell the user which frame now has it. */
      const takeFocus = Effect.fn("FrameLink.takeFocus")(function* () {
        // `window.focus()` does nothing, or it throws, in a frame that the user
        // has not interacted with. The message below is what the user sees.
        yield* pipe(
          dom.attempt("Window.focus", () => {
            dom.window.focus();
          }),
          Effect.ignore,
        );
        yield* report.info("Frame focused");
      });

      /** The messages that the coordinator answers, and the verdict that it pushes. */
      const serveAsCoordinator = Effect.gen(function* () {
        // The URL of the top frame is the URL that decides the verdict, and a
        // child frame cannot read it across origins.
        yield* bus.serve("EXCLUSION_REQUEST", () =>
          pipe(
            exclusions.resolveLocal,
            Effect.map((rule) =>
              Option.some({ kind: "EXCLUSION_RESULT" as const, exclusion: rule }),
            ),
          ),
        );

        yield* bus.serve("FOCUS_FRAME", ({ message }) =>
          pipe(elect(message.direction), Effect.as(Option.none())),
        );

        yield* bus.serve("FOCUSED", ({ from }) =>
          pipe(focusedRef, Ref.set(Option.some(from)), Effect.as(Option.none())),
        );

        // The top frame owns the verdict, and `Exclusions` works it out again
        // whenever the settings or the URL change. Each verdict that it takes
        // therefore goes out to the frames at once.
        yield* pipe(
          exclusions.changes,
          Stream.filterMap(Filter.fromPredicateOption(knownRule)),
          Stream.runForEach(pushVerdict),
          Effect.forkScoped,
        );

        // Saved settings wait in a debounce window before they reach storage.
        // A frame that read storage on the change would keep the old settings.
        yield* pipe(
          settings.committed,
          Stream.runForEach(() => pushSettings),
          Effect.forkScoped,
        );
      });

      /**
       * What a member does with a push of the settings: it reads its own
       * storage again.
       *
       * A pushed verdict goes to `Exclusions`, through `TopFrameVerdict`.
       */
      const serveAsMember = bus.serve("SETTINGS", () =>
        pipe(settings.reload, Effect.as(Option.none())),
      );

      // ---------------------------------------------------------------------
      // The messages that this service answers
      // ---------------------------------------------------------------------

      yield* bus.serve("TAKE_FOCUS", () => pipe(takeFocus(), Effect.as(Option.none())));

      yield* pipe(
        bus.role,
        FrameRole.$match({
          Top: () => serveAsCoordinator,
          Child: () => serveAsMember,
        }),
      );

      // The cursor of the top frame must follow the user. A click into a frame
      // moves it, so `gf` continues from there.
      yield* dom.listen("window", "focus", () =>
        pipe(bus.send(toTop, { kind: "FOCUSED" }), Effect.ignore),
      );

      return FrameLink.of({
        focusFrame: (direction) => bus.send(toTop, { kind: "FOCUS_FRAME", direction }),
      });
    }),
  );
}
