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

import {
  Array,
  Cause,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Struct,
  flow,
  pipe,
} from "effect";

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
export type Handler<R = never> = {
  readonly name: string;
  /**
   * Clean up after a body of this handler failed.
   *
   * The stack removes the frame first, and then calls this. The frame is
   * usually one part of something larger — a mode holds an indicator, a
   * singleton group, an overlay and its exit bodies — and only the owner can
   * release the rest. This body must not suspend. See `ARCHITECTURE.md`
   * section 3.
   */
  readonly onDefect?: (cause: Cause.Cause<never>) => Effect.Effect<void, never, R>;
} & {
  readonly [K in HandlerEventName]?: (
    event: HandlerEventMap[K],
  ) => Effect.Effect<HandlerResult, never, R>;
};

export type HandlerId = number;

/** The body for one event, with its services already supplied. */
type BoundBody<K extends HandlerEventName> = (
  event: HandlerEventMap[K],
) => Effect.Effect<HandlerResult>;

/** The bodies of a handler whose services are already supplied, one for each event. */
type BoundBodies = { readonly [K in HandlerEventName]: Option.Option<BoundBody<K>> };

/** A handler whose services are already supplied. */
interface BoundHandler {
  readonly name: string;
  readonly bodies: BoundBodies;
  /** Tell the owner that a body failed. A handler with no `onDefect` does nothing. */
  readonly onDefect: (cause: Cause.Cause<never>) => Effect.Effect<void>;
}

interface StackEntry extends BoundHandler {
  readonly id: HandlerId;
}

interface StackState {
  readonly entries: ReadonlyArray<StackEntry>;
  readonly nextId: HandlerId;
}

/** Where a new entry goes: on top, where it sees an event first, or at the bottom. */
type Placement = (
  entry: StackEntry,
) => (entries: ReadonlyArray<StackEntry>) => ReadonlyArray<StackEntry>;

const ON_TOP: Placement = Array.append;
const AT_BOTTOM: Placement = Array.prepend;

/**
 * Supply the services of a handler once.
 *
 * The event bodies each take an event and answer with a result. The cleanup
 * body takes a cause, and not an event, so it is bound on its own.
 */
const bound = <R>(handler: Handler<R>, services: Context.Context<R>): BoundHandler => {
  const provided = <A>(
    body: ((event: A) => Effect.Effect<HandlerResult, never, R>) | undefined,
  ): Option.Option<(event: A) => Effect.Effect<HandlerResult>> =>
    pipe(
      body,
      Option.fromUndefinedOr,
      Option.map((run) => flow(run, Effect.provideContext(services))),
    );
  return {
    name: handler.name,
    bodies: {
      keydown: provided(handler.keydown),
      keypress: provided(handler.keypress),
      keyup: provided(handler.keyup),
      click: provided(handler.click),
      mousedown: provided(handler.mousedown),
      focus: provided(handler.focus),
      blur: provided(handler.blur),
      scroll: provided(handler.scroll),
    },
    onDefect: pipe(
      handler.onDefect,
      Option.fromUndefinedOr,
      Option.match({
        onNone: () => () => Effect.void,
        onSome: (run) => flow(run, Effect.provideContext(services)),
      }),
    ),
  };
};

/** Give a bound handler the next id, and place it on the stack. */
const added =
  (handler: BoundHandler, place: Placement) =>
  ({ entries, nextId }: StackState): readonly [HandlerId, StackState] => {
    const id = nextId + 1;
    const entry: StackEntry = pipe(handler, Struct.assign({ id }));
    return [id, { nextId: id, entries: pipe(entries, place(entry)) }];
  };

const without = (id: HandlerId): ((current: StackState) => StackState) =>
  Struct.evolve({
    entries: (entries) =>
      pipe(
        entries,
        Array.filter((entry) => entry.id !== id),
      ),
  });

/** The body that a live entry gives for this event. */
const liveBody = <K extends HandlerEventName>(
  entries: ReadonlyArray<StackEntry>,
  id: HandlerId,
  name: K,
): Option.Option<BoundBody<K>> =>
  pipe(
    entries,
    Array.findFirst((entry) => entry.id === id),
    Option.flatMap((entry): Option.Option<BoundBody<K>> => pipe(entry.bodies, Struct.get(name))),
  );

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

export class HandlerStack extends Context.Service<
  HandlerStack,
  {
    /** Put a handler on top. It sees an event first. */
    readonly push: <R>(handler: Handler<R>) => Effect.Effect<HandlerId, never, R>;

    /** Put a handler at the bottom. It sees an event last. */
    readonly unshift: <R>(handler: Handler<R>) => Effect.Effect<HandlerId, never, R>;

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
  }
>()("vimium/core/HandlerStack") {
  static readonly layer: Layer.Layer<HandlerStack> = Layer.effect(
    HandlerStack,
    Effect.gen(function* () {
      const state = yield* Ref.make<StackState>({ entries: [], nextId: 0 });

      const insert = <R>(
        handler: Handler<R>,
        place: Placement,
      ): Effect.Effect<HandlerId, never, R> =>
        pipe(
          Effect.context<R>(),
          Effect.flatMap((services) =>
            pipe(state, Ref.modify(added(bound(handler, services), place))),
          ),
        );

      const remove = (id: HandlerId): Effect.Effect<void> => pipe(state, Ref.update(without(id)));

      const has = (id: HandlerId): Effect.Effect<boolean> =>
        pipe(
          Ref.get(state),
          Effect.map((current) =>
            pipe(
              current.entries,
              Array.some((entry) => entry.id === id),
            ),
          ),
        );

      /**
       * A real snapshot. Handlers push and pop modes while the walk is in
       * progress, and indexing into the live array while it changes skips
       * frames: a handler that removed itself moved every entry below it up by
       * one, so the next step went over one of them.
       */
      const snapshot = pipe(
        Ref.get(state),
        Effect.map((current) => current.entries),
      );

      /**
       * A handler that fails must not block the key path for the whole page.
       * Drop the frame, tell its owner, and continue. The owner holds
       * everything else that belongs to the frame.
       */
      const dropDefective = Effect.fnUntraced(function* (
        entry: StackEntry,
        name: HandlerEventName,
        cause: Cause.Cause<never>,
      ) {
        yield* Effect.logError(
          `the "${entry.name}" handler failed during ${name}`,
          Cause.pretty(cause),
        );
        yield* remove(entry.id);
        yield* pipe(
          entry.onDefect(cause),
          Effect.catchCause((failure) =>
            Effect.logError(
              `the owner of "${entry.name}" failed to clean up`,
              Cause.pretty(failure),
            ),
          ),
        );
        return CONTINUE_BUBBLING;
      });

      const bubble = <K extends HandlerEventName>(
        name: K,
        event: HandlerEventMap[K],
      ): Effect.Effect<boolean> => {
        /**
         * The answer of one entry of the snapshot.
         *
         * The snapshot is fixed. The stack is not. An entry that was removed
         * after the snapshot must not still see the event.
         */
        const answer = (entry: StackEntry): Effect.Effect<HandlerResult> =>
          pipe(
            Ref.get(state),
            Effect.map((current) => liveBody(current.entries, entry.id, name)),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(CONTINUE_BUBBLING),
                onSome: (body) =>
                  pipe(
                    body(event),
                    Effect.catchCause((cause) => dropDefective(entry, name, cause)),
                  ),
              }),
            ),
          );

        /** Give the event to each entry, from the top, until one decides. */
        const walk: (frames: ReadonlyArray<StackEntry>) => Effect.Effect<boolean> =
          Array.matchRight({
            onEmpty: () => Effect.succeed(true),
            onNonEmpty: (below, entry) =>
              pipe(
                answer(entry),
                Effect.flatMap((result) => decide(result, below)),
              ),
          });

        const decide = (
          result: HandlerResult,
          below: ReadonlyArray<StackEntry>,
        ): Effect.Effect<boolean> =>
          pipe(
            Match.value(result),
            Match.when("continue", () => walk(below)),
            Match.when("pass-to-page", () => Effect.succeed(true)),
            Match.when("suppress", () =>
              pipe(
                Effect.sync(() => suppressEvent(event)),
                Effect.as(false),
              ),
            ),
            Match.when("suppress-propagation", () =>
              pipe(
                Effect.sync(() => suppressPropagation(event)),
                Effect.as(false),
              ),
            ),
            // Take the snapshot again. A restart exists because the handler
            // has just pushed something that must see this event.
            Match.when("restart", () => pipe(snapshot, Effect.flatMap(walk))),
            Match.exhaustive,
          );

        return pipe(snapshot, Effect.flatMap(walk));
      };

      return HandlerStack.of({
        push: (handler) => insert(handler, ON_TOP),
        unshift: (handler) => insert(handler, AT_BOTTOM),
        remove,
        has,
        bubble,
        reset: pipe(state, Ref.update(Struct.assign({ entries: Array.empty<StackEntry>() }))),
        names: pipe(snapshot, Effect.map(Array.map((entry) => entry.name))),
        depth: pipe(
          snapshot,
          Effect.map((entries) => entries.length),
        ),
      });
    }),
  );
}
