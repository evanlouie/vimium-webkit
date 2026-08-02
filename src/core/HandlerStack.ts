/**
 * The handler stack.
 *
 * Modes are stack frames. A handler answers with a value that says what must
 * happen to the event next.
 *
 * The design comes from upstream Vimium's `lib/handler_stack.js` (MIT).
 *
 * A handler body is an `Effect`, and it must not suspend. `bubble` runs inside
 * the browser's own dispatch, because `preventDefault` works nowhere else. Read
 * `ARCHITECTURE.md` section 3.
 */

import { Cause, Context, Effect, Layer, Option, Ref } from "effect";

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * What must happen to the event next.
 *
 * A string union, and not a set of symbols. A `unique symbol` widens to plain
 * `symbol` whenever it passes through a generic, so a handler that gave the
 * wrong answer still typechecked, and sixteen call sites needed a cast to say
 * what they had already said. A string union survives inference, reads in a log
 * and crosses no boundary that a symbol would.
 */
export type HandlerResult =
  /** Continue down the stack. */
  | "continue"
  /** Stop here. The page still sees the event. */
  | "pass-to-page"
  /** `stopImmediatePropagation` and `preventDefault`. */
  | "suppress"
  /** `stopImmediatePropagation` only. The default action still happens. */
  | "suppress-propagation"
  /** Run the whole stack again, after a handler pushed another handler. */
  | "restart";

export const CONTINUE_BUBBLING: HandlerResult = "continue";
export const PASS_EVENT_TO_PAGE: HandlerResult = "pass-to-page";
export const SUPPRESS_EVENT: HandlerResult = "suppress";
export const SUPPRESS_PROPAGATION: HandlerResult = "suppress-propagation";
export const RESTART_BUBBLING: HandlerResult = "restart";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface HandlerEventMap {
  readonly keydown: KeyboardEvent;
  readonly keypress: KeyboardEvent;
  readonly keyup: KeyboardEvent;
  readonly click: MouseEvent;
  readonly mousedown: MouseEvent;
  readonly focus: FocusEvent;
  readonly blur: FocusEvent;
  readonly scroll: Event;
}

export type HandlerEventName = keyof HandlerEventMap;

/**
 * One frame of the stack.
 *
 * `R` is what the handler bodies need. `push` captures those services once, so
 * the stored handler needs nothing when the key path runs it.
 */
export type Handler<R = never> =
  & { readonly name: string }
  & {
    readonly [K in HandlerEventName]?: (
      event: HandlerEventMap[K],
    ) => Effect.Effect<HandlerResult, never, R>;
  };

export type HandlerId = number;

/** A handler whose services are already supplied. */
type BoundHandler = Handler<never>;

interface StackEntry {
  readonly id: HandlerId;
  readonly handler: BoundHandler;
}

interface StackState {
  readonly entries: ReadonlyArray<StackEntry>;
  readonly nextId: HandlerId;
}

/**
 * `stopImmediatePropagation`, and not `stopPropagation`.
 *
 * We can lose the race to register a listener, because `document-start` is not
 * reliable on WebKit. A page listener that was registered before ours on the
 * same target would still run under plain `stopPropagation`.
 */
const suppressPropagation = (event: Event): void => {
  event.stopImmediatePropagation();
};

const suppressEvent = (event: Event): void => {
  event.preventDefault();
  event.stopImmediatePropagation();
};

export class HandlerStack extends Context.Service<HandlerStack, {
  /** Put a handler on top. It sees an event first. */
  readonly push: <R>(
    handler: Handler<R>,
  ) => Effect.Effect<HandlerId, never, R>;

  /** Put a handler at the bottom. It sees an event last. */
  readonly unshift: <R>(
    handler: Handler<R>,
  ) => Effect.Effect<HandlerId, never, R>;

  readonly remove: (id: HandlerId) => Effect.Effect<void>;
  readonly has: (id: HandlerId) => Effect.Effect<boolean>;

  /**
   * Give each handler, from the top, a chance at the event.
   *
   * Answers `true` when the event may continue to the page.
   */
  readonly bubble: <K extends HandlerEventName>(
    name: K,
    event: HandlerEventMap[K],
  ) => Effect.Effect<boolean>;

  /** Drop every handler. */
  readonly reset: Effect.Effect<void>;

  /** The live handler names, innermost last. For diagnostics. */
  readonly names: Effect.Effect<ReadonlyArray<string>>;

  readonly depth: Effect.Effect<number>;
}>()("vimium/core/HandlerStack") {
  static readonly layer: Layer.Layer<HandlerStack> = Layer.effect(
    HandlerStack,
    Effect.gen(function*() {
      const state = yield* Ref.make<StackState>({ entries: [], nextId: 0 });

      const bind = <R>(
        handler: Handler<R>,
      ): Effect.Effect<BoundHandler, never, R> =>
        Effect.gen(function*() {
          const services = yield* Effect.context<R>();
          const bound: Record<string, unknown> = { name: handler.name };
          for (const key of Object.keys(handler)) {
            if (key === "name") continue;
            const body = (handler as Record<string, unknown>)[key];
            if (typeof body !== "function") continue;
            const run = body as (
              event: Event,
            ) => Effect.Effect<HandlerResult, never, R>;
            bound[key] = (event: Event) =>
              Effect.provideContext(run(event), services);
          }
          return bound as unknown as BoundHandler;
        });

      const insert = <R>(
        handler: Handler<R>,
        onTop: boolean,
      ): Effect.Effect<HandlerId, never, R> =>
        Effect.gen(function*() {
          const bound = yield* bind(handler);
          return yield* Ref.modify(state, (current) => {
            const id = current.nextId + 1;
            const entry: StackEntry = { id, handler: bound };
            return [
              id,
              {
                nextId: id,
                entries: onTop
                  ? [...current.entries, entry]
                  : [entry, ...current.entries],
              },
            ];
          });
        });

      const remove = (id: HandlerId): Effect.Effect<void> =>
        Ref.update(state, (current) => ({
          ...current,
          entries: current.entries.filter((entry) => entry.id !== id),
        }));

      const has = (id: HandlerId): Effect.Effect<boolean> =>
        Effect.map(
          Ref.get(state),
          (current) => current.entries.some((entry) => entry.id === id),
        );

      const bodyOf = (
        handler: BoundHandler,
        name: HandlerEventName,
      ): Option.Option<(event: Event) => Effect.Effect<HandlerResult>> => {
        const body = (handler as Record<string, unknown>)[name];
        return typeof body === "function"
          ? Option.some(
            body as (event: Event) => Effect.Effect<HandlerResult>,
          )
          : Option.none();
      };

      const bubble = <K extends HandlerEventName>(
        name: K,
        event: HandlerEventMap[K],
      ): Effect.Effect<boolean> =>
        Effect.gen(function*() {
          // A real snapshot. Handlers push and pop modes while the walk is in
          // progress, and indexing into the live array while it changes skips
          // frames: a handler that removed itself moved every entry below it up
          // by one, so the next step went over one of them.
          let frames = (yield* Ref.get(state)).entries;
          let index = frames.length - 1;

          while (index >= 0) {
            const entry = frames[index];
            index--;
            if (entry === undefined) continue;

            // The snapshot is fixed. The stack is not. An entry that was
            // removed after the snapshot must not still see the event.
            if (!(yield* has(entry.id))) continue;

            const body = bodyOf(entry.handler, name);
            if (Option.isNone(body)) continue;

            const outcome = yield* Effect.exit(body.value(event));
            let result: HandlerResult;
            if (outcome._tag === "Success") {
              result = outcome.value;
            } else {
              // A handler that fails must not block the key path for the whole
              // page. Drop the frame and continue.
              yield* Effect.logError(
                `the "${entry.handler.name}" handler failed during ${name}`,
                Cause.pretty(outcome.cause),
              );
              yield* remove(entry.id);
              result = CONTINUE_BUBBLING;
            }

            switch (result) {
              case CONTINUE_BUBBLING:
                continue;
              case PASS_EVENT_TO_PAGE:
                return true;
              case SUPPRESS_EVENT:
                suppressEvent(event);
                return false;
              case SUPPRESS_PROPAGATION:
                suppressPropagation(event);
                return false;
              case RESTART_BUBBLING:
                // Take the snapshot again. A restart exists because the handler
                // has just pushed something that must see this event.
                frames = (yield* Ref.get(state)).entries;
                index = frames.length - 1;
                continue;
            }
          }

          return true;
        });

      return HandlerStack.of({
        push: (handler) => insert(handler, true),
        unshift: (handler) => insert(handler, false),
        remove,
        has,
        bubble,
        reset: Ref.update(state, (current) => ({ ...current, entries: [] })),
        names: Effect.map(
          Ref.get(state),
          (current) => current.entries.map((entry) => entry.handler.name),
        ),
        depth: Effect.map(Ref.get(state), (current) => current.entries.length),
      });
    }),
  );
}
