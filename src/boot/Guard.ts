/**
 * The guard: one instance of this application in one realm, and not before it
 * is wanted.
 *
 * This code runs in **every frame of every page**, whether or not the user ever
 * presses a key. A page with twenty frames pays for it twenty times. Therefore
 * the guard does no DOM writes, reads no storage and builds no user interface.
 * It listens, and it waits.
 *
 * Two facts about WebKit shape this file:
 *
 * - `@run-at document-start` is not reliable. We must assume that we started
 *   late, possibly after the page registered its own key listeners, and still
 *   be correct.
 * - Safari restores a page from the back/forward cache without running the
 *   scripts again. `pageshow` and `pagehide` are therefore the lifecycle events
 *   that matter. This project never uses `unload`, because Safari keeps a page
 *   that has an `unload` handler and then never sends the event.
 */

import {
  Array,
  Boolean,
  Deferred,
  Effect,
  Option,
  Predicate,
  Ref,
  Schema,
  type Scope,
  flow,
  pipe,
} from "effect";
import { Dom } from "~/platform/Dom.ts";
import { isEditable } from "~/platform/Elements.ts";
import { Realm, WAKE_MESSAGE } from "~/platform/Realm.ts";

/**
 * The guard property.
 *
 * `Symbol.for` cannot be avoided. The two injections share no module scope, so
 * the key must come from a constant, which means that the page can derive it
 * too. What the page must not get is the instance. The property is therefore a
 * bare marker, and it is not writable, so the page cannot exchange it for one
 * that lies.
 *
 * The page can still detect us. That is not worth a defence: the overlay host is
 * an element in the page's own document.
 */
const GUARD = Symbol.for("vimium-webkit.stage0");

/**
 * How many keys to hold while the application starts.
 *
 * Holding them cannot be avoided. Reading the settings is asynchronous on every
 * manager, because `GM.getValue` gives only a promise on quoid.
 */
const MAX_BUFFERED_KEYS = 16;

/** How long the top frame waits before it starts on its own. */
const IDLE_START_MS = 1200;

export const ActivationReason = Schema.Literals(["keydown", "wake", "idle"]);
export type ActivationReason = typeof ActivationReason.Type;

export interface BootSignal {
  readonly reason: ActivationReason;
  /** Whether the user typed into an editable element since we started. */
  readonly typedIntoEditable: Effect.Effect<boolean>;
  /**
   * Take the held keys, oldest first.
   *
   * Call this after the key bridge is attached, and immediately before the
   * guard scope closes. The buffer keeps filling until then, so a key that
   * arrives while the application starts is not lost.
   */
  readonly drain: Effect.Effect<ReadonlyArray<KeyboardEvent>>;
}

/** The keys that the guard holds while the application starts, oldest first. */
type HeldKeys = ReadonlyArray<KeyboardEvent>;

const NO_KEYS: HeldKeys = [];

/** The keys that only change what another key means. */
const MODIFIER_KEYS: ReadonlyArray<string> = ["Shift", "Control", "Alt", "Meta"];

/** Is the marker of an instance on this realm already? */
const isClaimed: (window: Window) => boolean = flow(
  Option.liftPredicate(Predicate.hasProperty(GUARD)),
  Option.exists((scope) => scope[GUARD] === true),
);

/**
 * Put the marker on this realm.
 *
 * It is not writable, so the page cannot exchange it for one that lies. It is
 * configurable, so that a test realm can undo it. A page that deletes it gains
 * nothing: it cannot make the manager inject a second copy.
 */
const mark = (window: Window): boolean =>
  Reflect.defineProperty(window, GUARD, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: true,
  });

/**
 * Claim this realm.
 *
 * It answers `false` when the realm already has an instance, which happens when
 * a manager injects us twice, or when two copies of the script are installed.
 */
export const claimRealm: Effect.Effect<boolean, never, Dom> = Effect.gen(function* () {
  const dom = yield* Dom;
  return yield* pipe(
    isClaimed(dom.window),
    Boolean.match({
      onTrue: () => Effect.succeed(false),
      onFalse: () =>
        pipe(
          dom.probeOr(() => mark(dom.window), false),
          Effect.as(true),
        ),
    }),
  );
});

/**
 * The node that the event truly started at.
 *
 * A key event inside an open shadow root is retargeted to the host before a
 * window listener sees it. `event.target` then names the host, and the
 * editable test answers "no" for a user who is typing into a search box.
 *
 * The first node of `composedPath()` is the true node while the root is open.
 * A closed root gives the host, which is the correct answer there.
 */
const composedSource = (event: Event): EventTarget | null =>
  pipe(
    event.composedPath(),
    Array.head,
    Option.getOrElse(() => event.target),
  );

/**
 * Did the user make this key, and not the page?
 *
 * The check is inline, because the guard imports nothing above the platform. A
 * page can dispatch a `KeyboardEvent` that names any key, and only the browser
 * can set `isTrusted`.
 */
const madeByUser = (event: KeyboardEvent): boolean => event.isTrusted === true;

/**
 * Must this key start the application?
 *
 * A page that the user is only typing into must never pay the cost. The
 * editable test is structural, and not a `getComputedStyle` call, because this
 * runs for every keystroke in every frame.
 */
const startsApplication = (event: KeyboardEvent, source: EventTarget | null): boolean =>
  !event.isComposing &&
  event.keyCode !== 229 &&
  !pipe(MODIFIER_KEYS, Array.contains(event.key)) &&
  !isEditable(source);

/**
 * The wake message, as `platform/Realm.ts` sends it.
 *
 * Only an ancestor may wake us. An ancestor can already create and destroy this
 * frame, so it gains nothing from waking it. Without the test of the sender,
 * the page's own script, a sibling frame or an opener could force a full start
 * in every frame on the page with one known string.
 */
const WakeMessage = Schema.Struct({
  magic: Schema.Literal(WAKE_MESSAGE.magic),
  v: Schema.Literal(WAKE_MESSAGE.v),
  kind: Schema.Literal(WAKE_MESSAGE.kind),
});

const isWakeMessage = Schema.is(WakeMessage);

/**
 * Listen, and give the signal when something says that the user wants us.
 *
 * The listeners belong to the enclosing scope. Keep that scope open until the
 * key bridge is attached, or a key that arrives during the start is lost.
 */
export const awaitActivation: Effect.Effect<BootSignal, never, Dom | Realm | Scope.Scope> =
  Effect.gen(function* () {
    const dom = yield* Dom;
    const realm = yield* Realm;

    const buffer = yield* Ref.make(NO_KEYS);
    const typed = yield* Ref.make(false);
    const started = yield* Deferred.make<ActivationReason>();

    /**
     * Give the signal, when the realm is still there.
     *
     * The realm may have gone since we started, for example a frame that was
     * removed while a timer was pending. Nothing that we build there could be
     * seen or used. The check reads the realm when the signal is given, and
     * not when the guard started.
     */
    const activate = (reason: ActivationReason): Effect.Effect<void> =>
      pipe(started, Deferred.succeed(reason), Effect.when(realm.isLive), Effect.asVoid);

    /**
     * Hold a key that starts the application, and start it.
     *
     * The application replays this exact event once it is ready. Suppress it
     * now, while the browser dispatch is still synchronous, or the page acts
     * once and the replayed binding acts again. A command that needs the user
     * activation also needs this: `preventDefault` after the start is too late.
     * A key past the limit of the buffer is still suppressed, and not held.
     */
    const holdKey = Effect.fnUntraced(function* (event: KeyboardEvent) {
      yield* pipe(
        buffer,
        Ref.update<HeldKeys>(flow(Array.append(event), Array.take(MAX_BUFFERED_KEYS))),
      );
      yield* Effect.sync(() => {
        event.preventDefault();
        event.stopImmediatePropagation();
      });
      yield* activate("keydown");
    });

    const onUserKey = Effect.fnUntraced(function* (event: KeyboardEvent) {
      // The composed path, and not `event.target`. A key inside an open shadow
      // root names the host at a window listener. The call belongs to the
      // page, so it goes through the probe. A page that poisons `composedPath`
      // then costs us the shadow case only, and not the whole guard.
      const source = yield* dom.probeOr(() => composedSource(event), event.target);
      yield* pipe(
        typed,
        Ref.update((before) => before || isEditable(source)),
      );
      const waiting = yield* pipe(started, Deferred.isDone, Effect.map(Boolean.not));
      yield* pipe(
        event,
        Option.liftPredicate((key) => waiting && startsApplication(key, source)),
        Option.match({ onNone: () => Effect.void, onSome: holdKey }),
      );
    });

    /** Start when an ancestor asks us to. */
    const wakeFrom = (source: MessageEventSource | null): Effect.Effect<void> =>
      pipe(activate("wake"), Effect.when(realm.isAncestor(source)), Effect.asVoid);

    // A key that the page made, and not the user, must not start the
    // application. It must also stay out of the buffer, because the
    // application replays the buffer. The page would otherwise choose the
    // command that runs.
    yield* dom.listen(
      "window",
      "keydown",
      flow(
        Option.liftPredicate(madeByUser),
        Option.match({ onNone: () => Effect.void, onSome: onUserKey }),
      ),
      { capture: true },
    );

    yield* dom.listen(
      "window",
      "message",
      flow(
        Option.liftPredicate((message: MessageEvent) => isWakeMessage(message.data)),
        Option.match({ onNone: () => Effect.void, onSome: (message) => wakeFrom(message.source) }),
      ),
    );

    // The top frame warms up on its own, so that the first keystroke feels
    // immediate. A child frame waits for a key of its own, or for the wake that
    // a cross-frame function sends.
    yield* pipe(
      realm.isTop,
      Boolean.match({
        onTrue: () =>
          pipe(
            activate("idle"),
            Effect.delay(`${IDLE_START_MS} millis`),
            Effect.forkScoped,
            Effect.asVoid,
          ),
        onFalse: () => Effect.void,
      }),
    );

    const reason = yield* Deferred.await(started);

    return {
      reason,
      typedIntoEditable: Ref.get(typed),
      drain: pipe(buffer, Ref.getAndSet(NO_KEYS)),
    };
  });
