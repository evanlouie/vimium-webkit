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

import { Deferred, Effect, Option, Ref, Schema, type Scope } from "effect";
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

interface GuardedGlobal {
  [GUARD]?: true;
}

/**
 * Claim this realm.
 *
 * It answers `false` when the realm already has an instance, which happens when
 * a manager injects us twice, or when two copies of the script are installed.
 */
export const claimRealm: Effect.Effect<boolean, never, Dom> = Effect.gen(
  function*() {
    const dom = yield* Dom;
    const scope = dom.window as unknown as GuardedGlobal;
    if (scope[GUARD] === true) return false;
    yield* dom.probeOr(() => {
      Object.defineProperty(dom.window, GUARD, {
        value: true,
        writable: false,
        enumerable: false,
        // Configurable, so that a test realm can undo it. A page that deletes
        // it gains nothing: it cannot make the manager inject a second copy.
        configurable: true,
      });
      return true;
    }, false);
    return true;
  },
);

/**
 * Is this a key that must start the application?
 *
 * A page that the user is only typing into must never pay the cost. The
 * editable test is structural, and not a `getComputedStyle` call, because this
 * runs for every keystroke in every frame.
 */
const isUninteresting = (event: KeyboardEvent): boolean => {
  if (event.isComposing || event.keyCode === 229) return true;
  const key = event.key;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
    return true;
  }
  return isEditable(event.target);
};

/**
 * Is this a wake message that we must honour?
 *
 * Only an ancestor may wake us. An ancestor can already create and destroy this
 * frame, so it gains nothing from waking it. Without the test, the page's own
 * script, a sibling frame or an opener could force a full start in every frame
 * on the page with one known string.
 */
const isWakeMessage = (data: unknown): boolean => {
  if (typeof data !== "object" || data === null) return false;
  const message = data as {
    magic?: unknown;
    v?: unknown;
    kind?: unknown;
  };
  return message.magic === WAKE_MESSAGE.magic &&
    message.v === WAKE_MESSAGE.v &&
    message.kind === WAKE_MESSAGE.kind;
};

/**
 * Listen, and give the signal when something says that the user wants us.
 *
 * The listeners belong to the enclosing scope. Keep that scope open until the
 * key bridge is attached, or a key that arrives during the start is lost.
 */
export const awaitActivation: Effect.Effect<
  BootSignal,
  never,
  Dom | Realm | Scope.Scope
> = Effect.gen(function*() {
  const dom = yield* Dom;
  const realm = yield* Realm;

  const buffer = yield* Ref.make<ReadonlyArray<KeyboardEvent>>([]);
  const typed = yield* Ref.make(false);
  const started = yield* Deferred.make<ActivationReason>();

  const activate = (reason: ActivationReason): Effect.Effect<void> =>
    Effect.gen(function*() {
      // The realm may have gone since we started, for example a frame that was
      // removed while a timer was pending. Nothing that we build there could be
      // seen or used.
      if (!realm.isLive) return;
      yield* Effect.asVoid(Deferred.succeed(started, reason));
    });

  yield* dom.listen("window", "keydown", (event) =>
    Effect.gen(function*() {
      // A key that the page made, and not the user. The check is inline,
      // because the guard imports nothing above the platform. A page can
      // dispatch a `KeyboardEvent` that names any key, and only the browser can
      // set `isTrusted`. Such a key must not start the application, and it must
      // not enter the buffer, because the application replays the buffer and
      // would then run the command that the page chose.
      if (event.isTrusted !== true) return;
      if (isEditable(event.target)) yield* Ref.set(typed, true);
      if (Option.isSome(yield* Deferred.poll(started))) return;
      if (isUninteresting(event)) return;

      yield* Ref.update(buffer, (current) =>
        current.length >= MAX_BUFFERED_KEYS ? current : [...current, event]);

      // The application replays this exact event once it is ready. Suppress it
      // now, while the browser dispatch is still synchronous, or the page acts
      // once and the replayed binding acts again. A command that needs the
      // user activation also needs this: `preventDefault` after the start is
      // too late.
      event.preventDefault();
      event.stopImmediatePropagation();
      yield* activate("keydown");
    }), { capture: true });

  yield* dom.listen("window", "message", (event) =>
    Effect.gen(function*() {
      if (!isWakeMessage(event.data)) return;
      if (!(yield* realm.isAncestor(event.source))) return;
      yield* activate("wake");
    }));

  // The top frame warms up on its own, so that the first keystroke feels
  // immediate. A child frame waits for a key of its own, or for the wake that
  // a cross-frame function sends.
  if (realm.isTop) {
    yield* Effect.forkScoped(
      Effect.andThen(
        Effect.sleep(`${IDLE_START_MS} millis`),
        activate("idle"),
      ),
    );
  }

  const reason = yield* Deferred.await(started);

  return {
    reason,
    typedIntoEditable: Ref.get(typed),
    drain: Ref.getAndSet(buffer, []),
  };
});
