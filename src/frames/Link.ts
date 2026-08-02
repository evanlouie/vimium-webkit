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
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Stream,
  SubscriptionRef,
} from "effect";
import type { EffectiveRule } from "~/domain/Exclusion.ts";
import { DEFAULT_EXCLUSION } from "~/domain/FrameMessage.ts";
import { Exclusions } from "~/core/Exclusions.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { Dom } from "~/platform/Dom.ts";
import type { FrameId } from "~/platform/Realm.ts";
import {
  FrameBus,
  type FrameError,
  type InboundMessage,
  REQUEST_DEADLINE,
  toFrame,
  toTop,
} from "./Bus.ts";

/** Read the verdict out of the reply to an exclusion request. */
const readExclusion = (
  reply: InboundMessage,
): Option.Option<EffectiveRule> =>
  reply.message.kind === "EXCLUSION_RESULT"
    ? Option.some(reply.message.exclusion)
    : Option.none();

export class FrameLink extends Context.Service<FrameLink, {
  /** True when this frame belongs to a session. It never fails. */
  readonly ready: Effect.Effect<boolean>;

  /** The frames that the coordinator knows, in document order. */
  readonly knownFrames: Effect.Effect<ReadonlyArray<FrameId>>;

  /** Move the focus one frame along document order. This is `gf` and `gF`. */
  readonly focusFrame: (
    direction: 1 | -1,
  ) => Effect.Effect<void, FrameError>;

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
}>()("vimium/frames/FrameLink") {
  static readonly layer: Layer.Layer<
    FrameLink,
    never,
    FrameBus | Exclusions | Settings | Report | Dom
  > = Layer.effect(
    FrameLink,
    Effect.gen(function*() {
      const bus = yield* FrameBus;
      const exclusions = yield* Exclusions;
      const settings = yield* Settings;
      const report = yield* Report;
      const dom = yield* Dom;

      /** The frame that the focus cursor points at. The top frame keeps it. */
      const focusedRef = yield* Ref.make(Option.none<FrameId>());

      /** The verdict for the URL of the top frame. The top frame only. */
      const topVerdict: Effect.Effect<EffectiveRule> = Effect.flatMap(
        dom.href,
        exclusions.match,
      );

      const pushSettings: Effect.Effect<void> = bus.isTop
        ? Effect.gen(function*() {
          const rule = yield* topVerdict;
          yield* Effect.ignore(bus.broadcast({
            kind: "SETTINGS",
            exclusion: { enabled: rule.enabled, passKeys: rule.passKeys },
          }));
        })
        : Effect.void;

      const askTop: Effect.Effect<EffectiveRule, FrameError> = Effect.tap(
        bus.request(
          toTop,
          { kind: "EXCLUSION_REQUEST" },
          readExclusion,
          REQUEST_DEADLINE,
        ),
        (rule) => exclusions.adopt(rule),
      );

      const effectiveExclusion: Effect.Effect<EffectiveRule, FrameError> =
        bus.isTop ? topVerdict : askTop;

      /**
       * Give the focus to the next frame in document order.
       *
       * The cursor follows the `FOCUSED` messages, so `gf` continues from the
       * frame that the user is in, and not from where the cursor last stopped.
       */
      const elect = Effect.fn("FrameLink.elect")(function*(
        direction: 1 | -1,
      ) {
        const frames = yield* bus.peers;
        if (frames.length < 2) return;

        const cursor = yield* Ref.get(focusedRef);
        const current = Option.isNone(cursor)
          ? -1
          : frames.indexOf(cursor.value);
        const base = current < 0 ? 0 : current;
        const next = frames[(base + direction + frames.length) % frames.length];
        if (next === undefined) return;

        yield* Ref.set(focusedRef, Option.some(next));
        yield* Effect.ignore(bus.send(toFrame(next), { kind: "TAKE_FOCUS" }));
      });

      /** Take the focus, and tell the user which frame now has it. */
      const takeFocus = Effect.fn("FrameLink.takeFocus")(function*() {
        // `window.focus()` does nothing, or it throws, in a frame that the user
        // has not interacted with. The message below is what the user sees.
        yield* Effect.ignore(dom.attempt("Window.focus", () => {
          dom.window.focus();
        }));
        yield* report.info("Frame focused");
      });

      // ---------------------------------------------------------------------
      // The messages that this service answers
      // ---------------------------------------------------------------------

      yield* bus.serve(
        "TAKE_FOCUS",
        () => Effect.as(takeFocus(), Option.none()),
      );

      if (bus.isTop) {
        // The URL of the top frame is the URL that decides the verdict, and a
        // child frame cannot read it across origins.
        yield* bus.serve(
          "EXCLUSION_REQUEST",
          () =>
            Effect.map(topVerdict, (rule) =>
              Option.some({
                kind: "EXCLUSION_RESULT" as const,
                exclusion: { enabled: rule.enabled, passKeys: rule.passKeys },
              })),
        );

        yield* bus.serve(
          "FOCUS_FRAME",
          (message) =>
            message.message.kind === "FOCUS_FRAME"
              ? Effect.as(elect(message.message.direction), Option.none())
              : Effect.succeed(Option.none()),
        );

        yield* bus.serve("FOCUSED", (message) =>
          Effect.as(
            Ref.set(focusedRef, Option.some(message.from)),
            Option.none(),
          ));

        // The top frame owns the verdict, so every change of it goes out to the
        // frames. `Exclusions` recomputes the verdict when the settings change.
        yield* Effect.forkScoped(
          Stream.runForEach(
            SubscriptionRef.changes(exclusions.effective),
            () => pushSettings,
          ),
        );
      } else {
        yield* bus.serve(
          "SETTINGS",
          (message) =>
            message.message.kind === "SETTINGS"
              ? Effect.as(
                Effect.andThen(
                  // A prompt to read our own storage again, and never a value to
                  // take. Only the verdict travels.
                  Effect.ignore(settings.reload),
                  exclusions.adopt(message.message.exclusion),
                ),
                Option.none(),
              )
              : Effect.succeed(Option.none()),
        );

        // Until this frame is welcomed it has no verdict. A frame that started
        // before its welcome would otherwise stay fully enabled, for the life
        // of the document, on a page that the user excluded.
        yield* Effect.forkScoped(
          Effect.flatMap(
            bus.ready,
            (admitted) =>
              admitted ? Effect.ignore(askTop) : exclusions.adopt(
                DEFAULT_EXCLUSION,
              ),
          ),
        );
      }

      // The cursor of the top frame must follow the user. A click into a frame
      // moves it, so `gf` continues from there.
      yield* dom.listen(
        "window",
        "focus",
        () => Effect.ignore(bus.send(toTop, { kind: "FOCUSED" })),
      );

      return FrameLink.of({
        ready: bus.ready,
        knownFrames: bus.peers,
        focusFrame: (direction) =>
          bus.send(toTop, { kind: "FOCUS_FRAME", direction }),
        effectiveExclusion,
        pushSettings,
      });
    }),
  );
}
