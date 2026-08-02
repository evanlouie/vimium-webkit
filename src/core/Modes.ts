/**
 * Modes: stack frames with a lifecycle.
 *
 * A mode is a handler plus the standard exit conditions — escape, blur, click
 * and focus — and an optional singleton group. Entering find mode therefore
 * leaves visual mode without either one knowing about the other.
 *
 * The design comes from upstream Vimium's `content_scripts/mode.js` (MIT).
 *
 * The old version kept the live modes and the singleton table in two mutable
 * module-level variables. Two frames in one page shared them, and a test could
 * not reset them. Both now live in this service.
 */

import {
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  type Scope,
  SubscriptionRef,
} from "effect";
import {
  CONTINUE_BUBBLING,
  type Handler,
  type HandlerId,
  type HandlerResult,
  HandlerStack,
  SUPPRESS_EVENT,
} from "./HandlerStack.ts";

export type ModeIndicator = string | null;

export type ExitReason =
  | "explicit"
  | "escape"
  | "blur"
  | "click"
  | "focus"
  | "singleton"
  | "navigation";

export interface ModeOptions {
  readonly name: string;
  /** Text that the HUD shows while the mode is live. `null` shows nothing. */
  readonly indicator?: ModeIndicator;
  readonly exitOnEscape?: boolean;
  readonly exitOnBlur?: EventTarget | null;
  readonly exitOnClick?: boolean;
  readonly exitOnFocus?: boolean;
  /**
   * Take every keyboard event while the mode is live.
   *
   * For a modal overlay that owns the keyboard, and for the mode that holds
   * keys while the application starts.
   */
  readonly suppressAllKeyboardEvents?: boolean;
  /** Only one mode per group may be live. A second one exits the first. */
  readonly singleton?: string;
}

/** A live mode. Hold it to exit the mode, or to learn that it exited. */
export interface ModeHandle {
  readonly name: string;
  readonly isActive: Effect.Effect<boolean>;
  readonly exit: (reason?: ExitReason) => Effect.Effect<void>;
  /** Run `body` when the mode exits. It runs at once if it already exited. */
  readonly onExit: (
    body: (reason: ExitReason) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
}

interface LiveMode {
  readonly handle: ModeHandle;
  readonly indicator: ModeIndicator;
}

/**
 * Escape detection.
 *
 * `<c-[>` is an Escape synonym, as in Vim and in upstream Vimium. On a Mac
 * laptop with no physical Escape key it is the only comfortable way out.
 */
export const isEscape = (event: KeyboardEvent): boolean =>
  event.key === "Escape" ||
  (event.ctrlKey && (event.key === "[" || event.code === "BracketLeft"));

interface ModeState {
  readonly active: ReadonlyArray<LiveMode>;
  readonly singletons: ReadonlyMap<string, ModeHandle>;
}

export class Modes extends Context.Service<Modes, {
  /**
   * Enter a mode. It stays until it exits, or until the scope closes.
   *
   * The scope makes teardown structural. A feature that opens a mode inside its
   * own scope cannot leave the mode behind.
   */
  readonly enter: <R>(
    options: ModeOptions,
    handlers?: Omit<Handler<R>, "name">,
  ) => Effect.Effect<ModeHandle, never, R | Scope.Scope>;

  /** Exit every live mode. For a navigation and for `pagehide`. */
  readonly exitAll: (reason?: ExitReason) => Effect.Effect<void>;

  /** The indicator of the innermost live mode that has one. */
  readonly indicator: SubscriptionRef.SubscriptionRef<ModeIndicator>;

  /** The live mode names, innermost last. For diagnostics and for tests. */
  readonly activeNames: Effect.Effect<ReadonlyArray<string>>;
}>()("vimium/core/Modes") {
  static readonly layer: Layer.Layer<Modes, never, HandlerStack> = Layer.effect(
    Modes,
    Effect.gen(function*() {
      const stack = yield* HandlerStack;
      const state = yield* Ref.make<ModeState>({
        active: [],
        singletons: new Map(),
      });
      const indicator = yield* SubscriptionRef.make<ModeIndicator>(null);

      /** Show the innermost indicator that is not `null`. */
      const refreshIndicator = Effect.gen(function*() {
        const { active } = yield* Ref.get(state);
        for (let index = active.length - 1; index >= 0; index--) {
          const mode = active[index];
          if (mode !== undefined && mode.indicator !== null) {
            yield* SubscriptionRef.set(indicator, mode.indicator);
            return;
          }
        }
        yield* SubscriptionRef.set(indicator, null);
      });

      const enter = <R>(
        options: ModeOptions,
        handlers?: Omit<Handler<R>, "name">,
      ): Effect.Effect<ModeHandle, never, R | Scope.Scope> =>
        Effect.gen(function*() {
          const exited = yield* Ref.make(false);
          const exitBodies = yield* Ref.make<
            ReadonlyArray<(reason: ExitReason) => Effect.Effect<void>>
          >([]);
          const handlerId = yield* Ref.make<Option.Option<HandlerId>>(
            Option.none(),
          );

          const exit = (reason: ExitReason = "explicit"): Effect.Effect<void> =>
            Effect.gen(function*() {
              if (yield* Ref.getAndSet(exited, true)) return;

              const id = yield* Ref.getAndSet(handlerId, Option.none());
              if (Option.isSome(id)) yield* stack.remove(id.value);

              yield* Ref.update(state, (current) => ({
                active: current.active.filter(
                  (mode) => mode.handle !== handle,
                ),
                singletons: dropSingleton(
                  current.singletons,
                  options.singleton,
                  handle,
                ),
              }));

              const bodies = yield* Ref.getAndSet(exitBodies, []);
              for (const body of bodies) {
                yield* Effect.catchCause(
                  body(reason),
                  (cause) => Effect.logError("a mode exit body failed", cause),
                );
              }
              yield* refreshIndicator;
            });

          const handle: ModeHandle = {
            name: options.name,
            isActive: Effect.map(Ref.get(exited), (value) => !value),
            exit,
            onExit: (body) =>
              Effect.gen(function*() {
                if (yield* Ref.get(exited)) {
                  yield* body("explicit");
                  return;
                }
                yield* Ref.update(exitBodies, (current) => [...current, body]);
              }),
          };

          // A singleton group holds one mode. Push a second one, and the first
          // one exits.
          if (options.singleton !== undefined) {
            const previous = (yield* Ref.get(state)).singletons.get(
              options.singleton,
            );
            if (previous !== undefined) yield* previous.exit("singleton");
          }

          const own = handlers ?? {};
          const services = yield* Effect.context<R>();

          const provided = <A extends Event>(
            body:
              | ((event: A) => Effect.Effect<HandlerResult, never, R>)
              | undefined,
          ) =>
          (event: A): Effect.Effect<Option.Option<HandlerResult>> =>
            body === undefined ? Effect.succeedNone : Effect.provideContext(
              Effect.asSome(body(event)),
              services,
            );

          const keydownBody = provided(own.keydown);
          const keypressBody = provided(own.keypress);
          const keyupBody = provided(own.keyup);
          const clickBody = provided(own.click);
          const focusBody = provided(own.focus);
          const blurBody = provided(own.blur);

          const keyboard = (
            body: (
              event: KeyboardEvent,
            ) => Effect.Effect<Option.Option<HandlerResult>>,
          ) =>
          (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
            Effect.map(
              body(event),
              (result) =>
                Option.getOrElse(result, () =>
                  options.suppressAllKeyboardEvents === true
                    ? SUPPRESS_EVENT
                    : CONTINUE_BUBBLING),
            );

          const id = yield* stack.push<never>({
            name: options.name,
            keydown: (event) =>
              Effect.gen(function*() {
                if (options.exitOnEscape === true && isEscape(event)) {
                  yield* exit("escape");
                  // Suppressed, so that the page does not also act. This is what
                  // upstream does, and what a user who pressed Escape to leave
                  // our mode expects.
                  return SUPPRESS_EVENT;
                }
                return yield* keyboard(keydownBody)(event);
              }),
            keypress: keyboard(keypressBody),
            keyup: keyboard(keyupBody),
            click: (event) =>
              Effect.gen(function*() {
                if (options.exitOnClick === true) yield* exit("click");
                return Option.getOrElse(
                  yield* clickBody(event),
                  () => CONTINUE_BUBBLING,
                );
              }),
            focus: (event) =>
              Effect.gen(function*() {
                if (options.exitOnFocus === true) yield* exit("focus");
                return Option.getOrElse(
                  yield* focusBody(event),
                  () => CONTINUE_BUBBLING,
                );
              }),
            blur: (event) =>
              Effect.gen(function*() {
                const target = options.exitOnBlur;
                if (
                  target !== null && target !== undefined &&
                  event.target === target
                ) {
                  yield* exit("blur");
                }
                return Option.getOrElse(
                  yield* blurBody(event),
                  () => CONTINUE_BUBBLING,
                );
              }),
          });

          yield* Ref.set(handlerId, Option.some(id));
          yield* Ref.update(state, (current) => ({
            active: [
              ...current.active,
              { handle, indicator: options.indicator ?? null },
            ],
            singletons: options.singleton === undefined
              ? current.singletons
              : new Map(current.singletons).set(options.singleton, handle),
          }));
          yield* refreshIndicator;

          // The scope owns the mode. Nothing has to remember to exit it.
          yield* Effect.addFinalizer(() => exit("navigation"));

          return handle;
        });

      const exitAll = (
        reason: ExitReason = "navigation",
      ): Effect.Effect<void> =>
        Effect.gen(function*() {
          const { active } = yield* Ref.get(state);
          for (const mode of [...active].reverse()) {
            yield* mode.handle.exit(reason);
          }
        });

      return Modes.of({
        enter,
        exitAll,
        indicator,
        activeNames: Effect.map(
          Ref.get(state),
          (current) => current.active.map((mode) => mode.handle.name),
        ),
      });
    }),
  );
}

const dropSingleton = (
  singletons: ReadonlyMap<string, ModeHandle>,
  group: string | undefined,
  handle: ModeHandle,
): ReadonlyMap<string, ModeHandle> => {
  if (group === undefined || singletons.get(group) !== handle) {
    return singletons;
  }
  const next = new Map(singletons);
  next.delete(group);
  return next;
};
