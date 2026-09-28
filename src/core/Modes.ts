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
  Array,
  Boolean,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Record,
  Ref,
  type Scope,
  SubscriptionRef,
  flow,
  pipe,
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
  | "navigation"
  /** A body of the mode handler failed, so the stack dropped the frame. */
  | "defect";

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
  readonly onExit: (body: (reason: ExitReason) => Effect.Effect<void>) => Effect.Effect<void>;
}

/** A mode that is on the stack, and the text that the HUD shows for it. */
interface LiveMode {
  readonly handle: ModeHandle;
  readonly indicator: Option.Option<string>;
}

/**
 * Escape detection.
 *
 * `<c-[>` is an Escape synonym, as in Vim and in upstream Vimium. On a Mac
 * laptop with no physical Escape key it is the only comfortable way out.
 */
export const isEscape = (event: KeyboardEvent): boolean =>
  event.key === "Escape" || (event.ctrlKey && (event.key === "[" || event.code === "BracketLeft"));

interface ModeState {
  readonly active: ReadonlyArray<LiveMode>;
  /** The mode that holds each singleton group. */
  readonly singletons: Record.ReadonlyRecord<string, ModeHandle>;
}

type ExitBody = (reason: ExitReason) => Effect.Effect<void>;

/** A variant that carries no data. */
type NoFields = Record.ReadonlyRecord<never, never>;

/** The life of one mode. A mode that exited never comes back. */
type Life = Data.TaggedEnum<{
  /**
   * The mode is live. It knows its frame on the stack once the stack gives it
   * one, and it holds the bodies that its exit runs.
   */
  Live: { readonly handler: Option.Option<HandlerId>; readonly bodies: ReadonlyArray<ExitBody> };
  Exited: NoFields;
}>;
const Life = Data.taggedEnum<Life>();

const EXITED: Life = Life.Exited();

/** The live mode knows its frame on the stack. */
const attached = (id: HandlerId): ((life: Life) => Life) =>
  Life.$match({
    Live: ({ bodies }) => Life.Live({ handler: Option.some(id), bodies }),
    Exited: (exited) => exited,
  });

/**
 * Keep an exit body. A mode that already exited runs it at once instead.
 *
 * The answer is the effect to run now.
 */
const keptBody = (body: ExitBody): ((life: Life) => readonly [Effect.Effect<void>, Life]) =>
  Life.$match({
    Live: ({ handler, bodies }): readonly [Effect.Effect<void>, Life] => [
      Effect.void,
      Life.Live({ handler, bodies: pipe(bodies, Array.append(body)) }),
    ],
    Exited: (exited): readonly [Effect.Effect<void>, Life] => [body("explicit"), exited],
  });

/** The mode that holds a singleton group now. */
const holderOf =
  (group: Option.Option<string>) =>
  ({ singletons }: ModeState): Option.Option<ModeHandle> =>
    pipe(
      group,
      Option.flatMap((name) => pipe(singletons, Record.get(name))),
    );

/** Add a live mode. A mode in a singleton group takes the group. */
const joined =
  (mode: LiveMode, group: Option.Option<string>) =>
  ({ active, singletons }: ModeState): ModeState => ({
    active: pipe(active, Array.append(mode)),
    singletons: pipe(
      group,
      Option.match({
        onNone: () => singletons,
        onSome: (name) => pipe(singletons, Record.set(name, mode.handle)),
      }),
    ),
  });

/** Take a mode out. It gives up its singleton group only while it holds it. */
const left =
  (handle: ModeHandle, group: Option.Option<string>) =>
  (current: ModeState): ModeState => ({
    active: pipe(
      current.active,
      Array.filter((mode) => mode.handle !== handle),
    ),
    singletons: pipe(
      current,
      holderOf(group),
      Option.filter((holder) => holder === handle),
      Option.flatMap(() => group),
      Option.match({
        onNone: () => current.singletons,
        onSome: (name) => pipe(current.singletons, Record.remove(name)),
      }),
    ),
  });

/** The indicator of the innermost live mode that has one. */
const innermostIndicator = ({ active }: ModeState): ModeIndicator =>
  pipe(
    active,
    Array.findLast((mode) => mode.indicator),
    Option.getOrNull,
  );

export class Modes extends Context.Service<
  Modes,
  {
    /**
     * Enter a mode. It stays until it exits, or until the scope closes.
     *
     * The scope makes teardown structural. A feature that opens a mode inside its
     * own scope cannot leave the mode behind.
     */
    readonly enter: <R>(
      options: ModeOptions,
      handlers?: Omit<Handler<R>, "name" | "onDefect">,
    ) => Effect.Effect<ModeHandle, never, R | Scope.Scope>;

    /** Exit every live mode. For a navigation and for `pagehide`. */
    readonly exitAll: (reason?: ExitReason) => Effect.Effect<void>;

    /** The indicator of the innermost live mode that has one. */
    readonly indicator: SubscriptionRef.SubscriptionRef<ModeIndicator>;

    /** The live mode names, innermost last. For diagnostics and for tests. */
    readonly activeNames: Effect.Effect<ReadonlyArray<string>>;
  }
>()("vimium/core/Modes") {
  static readonly layer: Layer.Layer<Modes, never, HandlerStack> = Layer.effect(
    Modes,
    Effect.gen(function* () {
      const stack = yield* HandlerStack;
      const state = yield* Ref.make<ModeState>({ active: [], singletons: Record.empty() });
      const indicator = yield* SubscriptionRef.make<ModeIndicator>(null);

      /** Show the innermost indicator that is not `null`. */
      const refreshIndicator = pipe(
        Ref.get(state),
        Effect.map(innermostIndicator),
        Effect.flatMap((shown) => pipe(indicator, SubscriptionRef.set(shown))),
      );

      const enter = <R>(
        options: ModeOptions,
        handlers?: Omit<Handler<R>, "name" | "onDefect">,
      ): Effect.Effect<ModeHandle, never, R | Scope.Scope> =>
        Effect.gen(function* () {
          const group = Option.fromUndefinedOr(options.singleton);
          const life = yield* Ref.make<Life>(Life.Live({ handler: Option.none(), bodies: [] }));

          const close = Effect.fnUntraced(function* (
            handler: Option.Option<HandlerId>,
            bodies: ReadonlyArray<ExitBody>,
            reason: ExitReason,
          ) {
            yield* pipe(handler, Option.match({ onNone: () => Effect.void, onSome: stack.remove }));
            yield* pipe(state, Ref.update(left(handle, group)));
            yield* pipe(
              bodies,
              Effect.forEach(
                (body) =>
                  pipe(
                    body(reason),
                    Effect.catchCause((cause) => Effect.logError("a mode exit body failed", cause)),
                  ),
                { discard: true },
              ),
            );
            yield* refreshIndicator;
          });

          const exit = (reason: ExitReason = "explicit"): Effect.Effect<void> =>
            pipe(
              life,
              Ref.getAndSet(EXITED),
              Effect.flatMap(
                Life.$match({
                  Live: ({ handler, bodies }) => close(handler, bodies, reason),
                  Exited: () => Effect.void,
                }),
              ),
            );

          const handle: ModeHandle = {
            name: options.name,
            isActive: pipe(Ref.get(life), Effect.map(Life.$is("Live"))),
            exit,
            onExit: (body) => pipe(life, Ref.modify(keptBody(body)), Effect.flatten),
          };

          // A singleton group holds one mode. Push a second one, and the first
          // one exits.
          yield* pipe(
            Ref.get(state),
            Effect.map(holderOf(group)),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (previous) => previous.exit("singleton"),
              }),
            ),
          );

          const own = handlers ?? {};
          const services = yield* Effect.context<R>();

          const provided = <A extends Event>(
            body: ((event: A) => Effect.Effect<HandlerResult, never, R>) | undefined,
          ): ((event: A) => Effect.Effect<Option.Option<HandlerResult>>) =>
            pipe(
              body,
              Option.fromUndefinedOr,
              Option.match({
                onNone: () => () => Effect.succeedNone,
                onSome: (run) => flow(run, Effect.asSome, Effect.provideContext(services)),
              }),
            );

          /** The answer when a body gives none. */
          const answered =
            (unanswered: HandlerResult) =>
            <A extends Event>(body: (event: A) => Effect.Effect<Option.Option<HandlerResult>>) =>
              flow(body, Effect.map(Option.getOrElse(() => unanswered)));

          const keyboard = pipe(
            options.suppressAllKeyboardEvents === true,
            Boolean.match({ onFalse: () => CONTINUE_BUBBLING, onTrue: () => SUPPRESS_EVENT }),
            answered,
          );
          const other = answered(CONTINUE_BUBBLING);

          /** An exit that a flag of the options asks for. */
          const exitWhen = (flag: boolean | undefined, reason: ExitReason): Effect.Effect<void> =>
            pipe(
              flag === true,
              Boolean.match({ onFalse: () => Effect.void, onTrue: () => exit(reason) }),
            );

          const keydown = keyboard(provided(own.keydown));
          const click = other(provided(own.click));
          const focus = other(provided(own.focus));
          const blur = other(provided(own.blur));
          const escapeExits = options.exitOnEscape === true;
          const clickExit = exitWhen(options.exitOnClick, "click");
          const focusExit = exitWhen(options.exitOnFocus, "focus");
          const blurTarget = Option.fromNullishOr(options.exitOnBlur);

          const id = yield* stack.push<never>({
            name: options.name,
            // The stack drops a frame whose body failed. Only the mode can
            // release the rest: the singleton group, the indicator and the
            // exit bodies that hold the overlay of a feature.
            onDefect: () => exit("defect"),
            keydown: (event) =>
              pipe(
                escapeExits && isEscape(event),
                Boolean.match({
                  onFalse: () => keydown(event),
                  // Suppressed, so that the page does not also act. This is
                  // what upstream does, and what a user who pressed Escape to
                  // leave our mode expects.
                  onTrue: () => pipe(exit("escape"), Effect.as(SUPPRESS_EVENT)),
                }),
              ),
            keypress: keyboard(provided(own.keypress)),
            keyup: keyboard(provided(own.keyup)),
            click: (event) => pipe(clickExit, Effect.andThen(click(event))),
            focus: (event) => pipe(focusExit, Effect.andThen(focus(event))),
            blur: (event) =>
              pipe(
                blurTarget,
                Option.filter((target) => event.target === target),
                Option.match({ onNone: () => Effect.void, onSome: () => exit("blur") }),
                Effect.andThen(blur(event)),
              ),
          });

          yield* pipe(life, Ref.update(attached(id)));
          yield* pipe(
            state,
            Ref.update(
              joined({ handle, indicator: Option.fromNullishOr(options.indicator) }, group),
            ),
          );
          yield* refreshIndicator;

          // The scope owns the mode. Nothing has to remember to exit it.
          yield* Effect.addFinalizer(() => exit("navigation"));

          return handle;
        });

      const exitAll = (reason: ExitReason = "navigation"): Effect.Effect<void> =>
        pipe(
          Ref.get(state),
          Effect.flatMap(({ active }) =>
            pipe(
              active,
              Array.reverse,
              Effect.forEach((mode) => mode.handle.exit(reason), { discard: true }),
            ),
          ),
        );

      return Modes.of({
        enter,
        exitAll,
        indicator,
        activeNames: pipe(
          Ref.get(state),
          Effect.map(({ active }) =>
            pipe(
              active,
              Array.map((mode) => mode.handle.name),
            ),
          ),
        ),
      });
    }),
  );
}
