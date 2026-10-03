/**
 * The bridge from the browser's dispatch into the mode stack.
 *
 * Only the browser can set `isTrusted`. The bridge is the one door into the
 * mode stack, so it is where a page-made event must stop. A key that the page
 * made would otherwise run a command. A `focus` or a `blur` that the page made
 * would move insert mode. The next true key of the user would then run a
 * command inside a text field.
 *
 * The test replaces `Dom` with a stub that records each listener. It then calls
 * the recorded listener, which is exactly what the browser does.
 */

import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  type Context,
  Effect,
  Layer,
  Option,
  Ref,
  SubscriptionRef,
  Struct,
  pipe,
} from "effect";
import { attachKeyBridge } from "~/boot/KeyBridge.ts";
import { CONTINUE_BUBBLING } from "~/core/HandlerStack.ts";
import { Keyboard } from "~/core/Keyboard.ts";
import { KeyPolicy, Modes } from "~/core/Modes.ts";
import { Dom, type Listener, type TargetEventMap } from "~/platform/Dom.ts";

// ---------------------------------------------------------------------------
// The stubs
// ---------------------------------------------------------------------------

/**
 * The events of one dispatch, by target and by type.
 *
 * A recorded listener takes the event for its own target and type, so each
 * listener gets the kind of event that it asked for.
 */
type Dispatch = {
  readonly [K in keyof TargetEventMap]?: {
    readonly [T in keyof TargetEventMap[K]]?: TargetEventMap[K][T];
  };
};

/** A recorded listener. It gives the work to run when a dispatch has an event for it. */
type Attached = (events: Dispatch) => Option.Option<Effect.Effect<void>>;

/** The event of one target and type in a dispatch. */
const eventFor = <K extends keyof TargetEventMap, T extends keyof TargetEventMap[K]>(
  events: Dispatch,
  target: K,
  type: T,
): Option.Option<TargetEventMap[K][T]> =>
  pipe(
    Option.fromNullishOr(events[target]),
    Option.flatMap((byType) => Option.fromNullishOr(byType[type])),
  );

/**
 * `Dom.listen`, recording each listener instead of touching a window.
 *
 * A recorded listener keeps the services of its caller, as the real one does.
 */
const recordingListen =
  (attached: Ref.Ref<ReadonlyArray<Attached>>): Dom["Service"]["listen"] =>
  <K extends keyof TargetEventMap, T extends keyof TargetEventMap[K], R>(
    target: K,
    type: T,
    handler: Listener<TargetEventMap[K][T], R>,
  ): Effect.Effect<void, never, R> => {
    const listener =
      (services: Context.Context<R>): Attached =>
      (events) =>
        pipe(
          eventFor(events, target, type),
          Option.map((event) => pipe(handler(event), Effect.provideContext(services))),
        );
    return pipe(
      Effect.context<R>(),
      Effect.flatMap((services) =>
        pipe(attached, Ref.update<ReadonlyArray<Attached>>(Array.append(listener(services)))),
      ),
    );
  };

/** `Dom`, with `listen` recording instead of touching a window. */
const recordingDom = (attached: Ref.Ref<ReadonlyArray<Attached>>): Layer.Layer<Dom> =>
  pipe(
    Dom,
    Effect.map(Struct.assign({ listen: recordingListen(attached) })),
    Layer.effect(Dom),
    Layer.provide(Dom.layer),
  );

/** `Keyboard`, reduced to the one method that the bridge calls. */
const stubKeyboard = (forgotten: Ref.Ref<number>): Layer.Layer<Keyboard> =>
  pipe(
    SubscriptionRef.make(Option.none<string>()),
    Effect.map((pending) =>
      Keyboard.of({
        pending,
        passNextKey: () => Effect.void,
        forgetSuppressed: pipe(
          forgotten,
          Ref.update((count) => count + 1),
        ),
      }),
    ),
    Layer.effect(Keyboard),
  );

/**
 * A key, a click or a change of focus, as the bridge receives it.
 *
 * Node has none of those classes. The double extends Node's own `Event`, and
 * each member that the three add has the value of a plain event. The bridge
 * reads `isTrusted`, and the probe handlers read nothing.
 */
class BridgeEvent extends Event implements KeyboardEvent, PointerEvent, FocusEvent {
  readonly detail = 0;
  readonly view = null;
  readonly which = 0;
  readonly altKey = false;
  readonly ctrlKey = false;
  readonly metaKey = false;
  readonly shiftKey = false;
  readonly charCode = 0;
  readonly code = "";
  readonly isComposing = false;
  readonly key = "";
  readonly keyCode = 0;
  readonly location = 0;
  readonly repeat = false;
  readonly DOM_KEY_LOCATION_STANDARD = 0;
  readonly DOM_KEY_LOCATION_LEFT = 1;
  readonly DOM_KEY_LOCATION_RIGHT = 2;
  readonly DOM_KEY_LOCATION_NUMPAD = 3;
  readonly button = 0;
  readonly buttons = 0;
  readonly clientX = 0;
  readonly clientY = 0;
  readonly layerX = 0;
  readonly layerY = 0;
  readonly movementX = 0;
  readonly movementY = 0;
  readonly offsetX = 0;
  readonly offsetY = 0;
  readonly pageX = 0;
  readonly pageY = 0;
  readonly relatedTarget = null;
  readonly screenX = 0;
  readonly screenY = 0;
  readonly x = 0;
  readonly y = 0;
  readonly altitudeAngle = 0;
  readonly azimuthAngle = 0;
  readonly height = 0;
  readonly isPrimary = false;
  readonly persistentDeviceId = 0;
  readonly pointerId = 0;
  readonly pointerType = "";
  readonly pressure = 0;
  readonly tangentialPressure = 0;
  readonly tiltX = 0;
  readonly tiltY = 0;
  readonly twist = 0;
  readonly width = 0;

  /** `false` makes the event synthetic, as a page's `dispatchEvent` does. */
  constructor(
    type: string,
    override readonly isTrusted: boolean,
  ) {
    super(type);
  }

  getModifierState(): boolean {
    return false;
  }

  getCoalescedEvents(): PointerEvent[] {
    return [];
  }

  getPredictedEvents(): PointerEvent[] {
    return [];
  }

  initUIEvent(): void {}

  initKeyboardEvent(): void {}

  initMouseEvent(): void {}
}

/** An event that the user made. */
const byUser = (type: string): BridgeEvent => new BridgeEvent(type, true);

/** An event that the page made. */
const byPage = (type: string): BridgeEvent => new BridgeEvent(type, false);

/** Call every listener that has an event in this dispatch, as the browser would. */
const fire = (attached: ReadonlyArray<Attached>, events: Dispatch): Effect.Effect<void> =>
  pipe(
    attached,
    Array.map((listener) => listener(events)),
    Array.getSomes,
    Effect.all,
    Effect.asVoid,
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
  Effect.gen(function* () {
    const attached = yield* Ref.make<ReadonlyArray<Attached>>([]);
    const forgotten = yield* Ref.make(0);
    const layer = Layer.mergeAll(recordingDom(attached), Modes.layer, stubKeyboard(forgotten));

    const run = Effect.gen(function* () {
      const modes = yield* Modes;
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (name: string) => () =>
        pipe(
          seen,
          Ref.update<ReadonlyArray<string>>(Array.append(name)),
          Effect.as(CONTINUE_BUBBLING),
        );

      yield* modes.enter(
        {
          name: "probe",
          indicator: Option.none(),
          exitOn: [],
          keyboard: KeyPolicy.Shared(),
          singleton: Option.none(),
        },
        {
          keydown: record("keydown"),
          keypress: record("keypress"),
          keyup: record("keyup"),
          click: record("click"),
          focus: record("focus"),
          blur: record("blur"),
        },
      );

      yield* attachKeyBridge;
      const listeners = yield* Ref.get(attached);
      yield* body(listeners, seen, forgotten);
    });

    yield* pipe(run, Effect.scoped, Effect.provide(layer));
  });

describe("the key bridge", () => {
  it.effect("gives the stack an event that the user made", () =>
    withBridge((attached, seen) =>
      Effect.gen(function* () {
        yield* fire(attached, { window: { keydown: byUser("keydown") } });
        yield* fire(attached, { window: { keypress: byUser("keypress") } });
        yield* fire(attached, { window: { keyup: byUser("keyup") } });
        yield* fire(attached, { window: { click: byUser("click") } });
        yield* fire(attached, { window: { focus: byUser("focus") } });
        yield* fire(attached, { window: { blur: byUser("blur") } });
        assert.deepEqual(yield* Ref.get(seen), [
          "keydown",
          "keypress",
          "keyup",
          "click",
          "focus",
          "blur",
        ]);
      }),
    ),
  );

  it.effect("drops a key that the page made", () =>
    withBridge((attached, seen) =>
      Effect.gen(function* () {
        yield* fire(attached, { window: { keydown: byPage("keydown") } });
        yield* fire(attached, { window: { keypress: byPage("keypress") } });
        yield* fire(attached, { window: { keyup: byPage("keyup") } });

        assert.deepEqual(yield* Ref.get(seen), []);
      }),
    ),
  );

  it.effect("drops a focus and a blur that the page made", () =>
    withBridge((attached, seen) =>
      Effect.gen(function* () {
        // A page-made `blur` would leave insert mode, and the next true key of
        // the user would then run a command inside a text field.
        yield* fire(attached, { window: { focus: byPage("focus") } });
        yield* fire(attached, { window: { blur: byPage("blur") } });

        assert.deepEqual(yield* Ref.get(seen), []);
      }),
    ),
  );

  it.effect("keeps a click that the page made", () =>
    withBridge((attached, seen) =>
      Effect.gen(function* () {
        // Hint activation dispatches its own pointer events, and a mode that
        // exits on a click must still see them.
        yield* fire(attached, { window: { click: byPage("click") } });

        assert.deepEqual(yield* Ref.get(seen), ["click"]);
      }),
    ),
  );

  it.effect("forgets the taken presses on a true window blur only", () =>
    withBridge((attached, _seen, forgotten) =>
      Effect.gen(function* () {
        yield* fire(attached, { window: { blur: byPage("blur") } });
        assert.strictEqual(yield* Ref.get(forgotten), 0);

        yield* fire(attached, { window: { blur: byUser("blur") } });
        assert.strictEqual(yield* Ref.get(forgotten), 1);
      }),
    ),
  );
});
