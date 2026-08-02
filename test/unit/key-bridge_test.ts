/**
 * The bridge from the browser's dispatch into the handler stack.
 *
 * Only the browser can set `isTrusted`. The bridge is the one door into the
 * mode stack, so it is where a page-made event must stop. A key that the page
 * made would otherwise run a command. A `focus` or a `blur` that the page made
 * would move insert mode, and the next true key of the user would then run a
 * command inside a text field.
 *
 * The test replaces `Dom` with a stub that records each listener. It then calls
 * the recorded listener, which is exactly what the browser does.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref, SubscriptionRef } from "effect";
import { attachKeyBridge } from "~/boot/KeyBridge.ts";
import { CONTINUE_BUBBLING, HandlerStack } from "~/core/HandlerStack.ts";
import { Keyboard } from "~/core/Keyboard.ts";
import { Dom } from "~/platform/Dom.ts";

// ---------------------------------------------------------------------------
// The stubs
// ---------------------------------------------------------------------------

interface Attached {
  readonly type: string;
  readonly run: (event: Event) => Effect.Effect<void>;
}

/** `Dom`, with `listen` recording instead of touching a window. */
const recordingDom = (
  attached: Ref.Ref<ReadonlyArray<Attached>>,
): Layer.Layer<Dom> =>
  Layer.effect(
    Dom,
    Effect.map(Dom, (dom) =>
      Dom.of({
        ...dom,
        // The cast says what the stub already is: every listener of the bridge
        // needs no service, so the recorded body is an `Effect<void>`.
        listen: ((
          _target: unknown,
          type: unknown,
          handler: (event: Event) => Effect.Effect<void>,
        ) =>
          Ref.update(attached, (current) => [
            ...current,
            { type: String(type), run: handler },
          ])) as unknown as Dom["Service"]["listen"],
      })),
  ).pipe(Layer.provide(Dom.layer));

/** `Keyboard`, reduced to the one method that the bridge calls. */
const stubKeyboard = (
  forgotten: Ref.Ref<number>,
): Layer.Layer<Keyboard> =>
  Layer.effect(
    Keyboard,
    Effect.map(
      SubscriptionRef.make<string | null>(null),
      (pending) =>
        Keyboard.of({
          pending,
          syncExclusion: Effect.void,
          passNextKey: () => Effect.void,
          forgetSuppressed: Ref.update(forgotten, (count) => count + 1),
        }),
    ),
  );

/** Everything that the bridge reads from an event. */
const event = (isTrusted: boolean): Event =>
  ({ isTrusted, type: "test" }) as unknown as Event;

/** Call every listener of this type, as the browser would. */
const fire = (
  attached: ReadonlyArray<Attached>,
  type: string,
  value: Event,
): Effect.Effect<void> =>
  Effect.forEach(
    attached.filter((entry) => entry.type === type),
    (entry) => entry.run(value),
    { discard: true },
  );

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

/** Attach the bridge, then let `body` fire the listeners that it recorded. */
const withBridge = (
  body: (
    attached: ReadonlyArray<Attached>,
    seen: Ref.Ref<ReadonlyArray<string>>,
    forgotten: Ref.Ref<number>,
  ) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const attached = yield* Ref.make<ReadonlyArray<Attached>>([]);
    const forgotten = yield* Ref.make(0);

    yield* Effect.provide(
      Effect.scoped(Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (name: string) => () =>
          Effect.as(
            Ref.update(seen, (current) => [...current, name]),
            CONTINUE_BUBBLING,
          );

        yield* stack.push({
          name: "probe",
          keydown: record("keydown"),
          keyup: record("keyup"),
          click: record("click"),
          focus: record("focus"),
          blur: record("blur"),
        });

        yield* attachKeyBridge;
        yield* body(yield* Ref.get(attached), seen, forgotten);
      })),
      Layer.mergeAll(
        recordingDom(attached),
        HandlerStack.layer,
        stubKeyboard(forgotten),
      ),
    );
  });

describe("the key bridge", () => {
  it.effect("gives the stack an event that the user made", () =>
    withBridge((attached, seen) =>
      Effect.gen(function*() {
        for (const type of ["keydown", "keyup", "click", "focus", "blur"]) {
          yield* fire(attached, type, event(true));
        }
        assert.deepEqual(yield* Ref.get(seen), [
          "keydown",
          "keyup",
          "click",
          "focus",
          "blur",
        ]);
      })
    ));

  it.effect("drops a key that the page made", () =>
    withBridge((attached, seen) =>
      Effect.gen(function*() {
        yield* fire(attached, "keydown", event(false));
        yield* fire(attached, "keyup", event(false));

        assert.deepEqual(yield* Ref.get(seen), []);
      })
    ));

  it.effect("drops a focus and a blur that the page made", () =>
    withBridge((attached, seen) =>
      Effect.gen(function*() {
        // A page-made `blur` would leave insert mode, and the next true key of
        // the user would then run a command inside a text field.
        yield* fire(attached, "focus", event(false));
        yield* fire(attached, "blur", event(false));

        assert.deepEqual(yield* Ref.get(seen), []);
      })
    ));

  it.effect("keeps a click that the page made", () =>
    withBridge((attached, seen) =>
      Effect.gen(function*() {
        // Hint activation dispatches its own pointer events, and a mode that
        // exits on a click must still see them.
        yield* fire(attached, "click", event(false));

        assert.deepEqual(yield* Ref.get(seen), ["click"]);
      })
    ));

  it.effect("forgets the taken presses on a true window blur only", () =>
    withBridge((attached, _seen, forgotten) =>
      Effect.gen(function*() {
        yield* fire(attached, "blur", event(false));
        assert.strictEqual(yield* Ref.get(forgotten), 0);

        yield* fire(attached, "blur", event(true));
        assert.strictEqual(yield* Ref.get(forgotten), 1);
      })
    ));
});
