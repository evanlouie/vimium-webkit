/**
 * The application protocol on top of the frame bus.
 *
 * `FrameBus` moves a message. This service gives the meaning of the messages
 * that every frame needs: which frames exist, which frame has the focus, and
 * what the exclusion verdict of the page is. It is the only user of the bus
 * that every build has.
 *
 * Two rules from the earlier code, which cost real reviews to find:
 *
 * - **Settings never come over the wire.** A `SETTINGS` message carries the
 *   exclusion verdict and nothing else. Settings used to travel with it, which
 *   made the protocol a route to push a CSS string, a search template and a
 *   key-mapping source into every frame of a page, and made the handshake a
 *   route to take the exclusion patterns, the mappings and the engine list of
 *   the user out of the top frame. A push is a prompt to read our own storage
 *   again, and it is not a source of truth.
 * - **A child frame does not decide its own verdict.** Upstream Vimium resolves
 *   an exclusion against `sender.tab.url`, which is the URL of the top frame.
 *   Without that, a rule that the user wrote for a page would stop applying
 *   inside the frames of that page, and an excluded page would still have us
 *   live inside its third-party frames. A child asks the top frame, and gives
 *   the answer to `Exclusions.adopt`.
 *
 * The hint protocol travels on the same bus, and it is not here. The hints
 * service answers `COLLECT_HINTS` and the other hint kinds for itself, with
 * `FrameBus.serve`. This file must not import anything from `src/features/`.
 */

import {
  Array,
  Boolean,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Stream,
  SubscriptionRef,
  pipe,
} from "effect";
import type { EffectiveRule } from "~/domain/Exclusion.ts";
import { DEFAULT_EXCLUSION, isKind } from "~/domain/FrameMessage.ts";
import { Exclusions } from "~/core/Exclusions.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { Dom } from "~/platform/Dom.ts";
import { type FrameId, FrameRole } from "~/platform/Realm.ts";
import {
  FrameBus,
  type FrameError,
  type InboundMessage,
  REQUEST_DEADLINE,
  toFrame,
  toTop,
} from "./Bus.ts";

/** Read the verdict out of the reply to an exclusion request. */
const readExclusion = (reply: InboundMessage): Option.Option<EffectiveRule> =>
  pipe(
    reply.message,
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

export class FrameLink extends Context.Service<
  FrameLink,
  {
    /** True when this frame belongs to a session. It never fails. */
    readonly ready: Effect.Effect<boolean>;

    /** The frames that the coordinator knows, in document order. */
    readonly knownFrames: Effect.Effect<ReadonlyArray<FrameId>>;

    /** Move the focus one frame along document order. This is `gf` and `gF`. */
    readonly focusFrame: (direction: 1 | -1) => Effect.Effect<void, FrameError>;

    /**
     * The verdict for the URL of the *top* frame.
     *
     * The top frame answers from its own URL. A child frame asks the top frame,
     * and adopts the answer. A child that gets no answer keeps the verdict that
     * it holds, which starts as "enabled, and no key passed through".
     */
    readonly effectiveExclusion: Effect.Effect<EffectiveRule, FrameError>;

    /**
     * Tell every frame that the settings changed.
     *
     * It carries the exclusion verdict only. Each frame reads its own storage
     * again. Below the top frame this does nothing.
     */
    readonly pushSettings: Effect.Effect<void>;
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

      /** The verdict for the URL of the top frame. The top frame only. */
      const topVerdict: Effect.Effect<EffectiveRule> = pipe(
        dom.href,
        Effect.flatMap(exclusions.match),
      );

      const broadcastVerdict = Effect.gen(function* () {
        const rule = yield* topVerdict;
        yield* pipe(bus.broadcast({ kind: "SETTINGS", exclusion: rule }), Effect.ignore);
      });

      const pushSettings: Effect.Effect<void> = pipe(
        bus.role,
        FrameRole.$match({
          Top: () => broadcastVerdict,
          Child: () => Effect.void,
        }),
      );

      const askTop: Effect.Effect<EffectiveRule, FrameError> = pipe(
        bus.request(toTop, { kind: "EXCLUSION_REQUEST" }, readExclusion, REQUEST_DEADLINE),
        Effect.tap((rule) => exclusions.adopt(rule)),
      );

      const effectiveExclusion: Effect.Effect<EffectiveRule, FrameError> = pipe(
        bus.role,
        FrameRole.$match({
          Top: () => topVerdict,
          Child: () => askTop,
        }),
      );

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
            topVerdict,
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

        // The top frame owns the verdict, so every change of it goes out to the
        // frames. `Exclusions` recomputes the verdict when the settings change.
        yield* pipe(
          SubscriptionRef.changes(exclusions.effective),
          Stream.runForEach(() => pushSettings),
          Effect.forkScoped,
        );
      });

      /** The messages that a member answers, and the verdict that it asks for. */
      const serveAsMember = Effect.gen(function* () {
        yield* bus.serve("SETTINGS", ({ message }) =>
          pipe(
            settings.reload,
            Effect.ignore,
            // A prompt to read our own storage again, and never a value to
            // take. Only the verdict travels.
            Effect.andThen(exclusions.adopt(message.exclusion)),
            Effect.as(Option.none()),
          ),
        );

        // Until this frame is welcomed it has no verdict. A frame that started
        // before its welcome would otherwise stay fully enabled, for the life
        // of the document, on a page that the user excluded.
        yield* pipe(
          bus.ready,
          Effect.flatMap(
            Boolean.match({
              onTrue: () => pipe(askTop, Effect.ignore),
              onFalse: () => exclusions.adopt(DEFAULT_EXCLUSION),
            }),
          ),
          Effect.forkScoped,
        );
      });

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
        ready: bus.ready,
        knownFrames: bus.peers,
        focusFrame: (direction) => bus.send(toTop, { kind: "FOCUS_FRAME", direction }),
        effectiveExclusion,
        pushSettings,
      });
    }),
  );
}
