/**
 * Modes: the handler stack, and the lifecycle of each of its frames.
 *
 * A mode is one frame of the stack. It answers the events that the key bridge
 * gives it, it has the standard exit conditions — escape, click and focus —
 * and it has an optional singleton group and an indicator. Entering find mode
 * therefore leaves visual mode without either one knowing about the other.
 *
 * The design comes from upstream Vimium's `content_scripts/mode.js` and
 * `lib/handler_stack.js` (MIT).
 *
 * The list of live modes is the stack. A mode takes its place by its tier, and
 * not by the moment that it was entered, so normal mode stays below insert mode
 * and insert mode stays below everything that a command opens.
 *
 * A body of a mode is an `Effect`, and it must not suspend. `bubble` runs
 * inside the browser's own dispatch, because `preventDefault` works nowhere
 * else. Read the section "The keyboard path is synchronous" of
 * `ARCHITECTURE.md`.
 */

import {
  Array,
  Boolean,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Match,
  HashSet,
  Option,
  Record,
  Ref,
  Scope,
  Stream,
  Struct,
  SubscriptionRef,
  flow,
  pipe,
} from "effect";
import { bindServices, type NoFields, type Unscoped, whenSome } from "~/domain/Prelude.ts";
import { isUserEvent } from "~/platform/Elements.ts";
import {
  CONTINUE_BUBBLING,
  type HandlerEventMap,
  type HandlerEventName,
  type HandlerResult,
  type Handlers,
  PASS_EVENT_TO_PAGE,
  SUPPRESS_EVENT,
  SUPPRESS_PROPAGATION,
} from "./HandlerStack.ts";
import { recoverEvenIfInterrupted } from "./Recovery.ts";

/** The text that the HUD shows for the live modes. `None` shows nothing. */
export type ModeIndicator = Option.Option<string>;

export type ExitReason =
  | "explicit"
  | "escape"
  | "click"
  | "focus"
  | "singleton"
  | "navigation"
  /** A body of the mode failed, so the stack dropped the mode. */
  | "defect";

/** An event that ends a mode, besides an explicit exit, its singleton group and a navigation. */
export type ExitTrigger = Data.TaggedEnum<{
  /**
   * Escape, or its `<c-[>` synonym. The mode takes the key, so that the page
   * does not also act on it.
   */
  Escape: NoFields;
  /** Any click. */
  Click: NoFields;
  /** Any focus. */
  Focus: NoFields;
}>;
export const ExitTrigger = Data.taggedEnum<ExitTrigger>();

/** Who gets a keyboard event that the bodies of the mode leave unanswered. */
export type KeyPolicy = Data.TaggedEnum<{
  /** The modes below this one, and then the page. */
  Shared: NoFields;
  /**
   * Nobody. The mode takes every keyboard event while it is live.
   *
   * For a modal overlay that owns the keyboard, and for the mode that holds
   * keys while the hints are collected.
   */
  Owned: NoFields;
}>;
export const KeyPolicy = Data.taggedEnum<KeyPolicy>();

/**
 * Where a mode sits on the stack.
 *
 * A mode sees an event before every mode of a lower tier. Inside one tier, the
 * mode that was entered last sees it first.
 */
export type ModeTier = Data.TaggedEnum<{
  /** Normal mode. It lives as long as the application. */
  Base: NoFields;
  /**
   * Insert mode. It sits above normal mode, so that a key that the user types
   * into a text field never reaches a binding.
   */
  Insert: NoFields;
  /** A mode that a command or a feature opens. A navigation ends it. */
  Transient: NoFields;
}>;
export const ModeTier = Data.taggedEnum<ModeTier>();

/** The height of a tier on the stack. */
const rankOf: (tier: ModeTier) => number = ModeTier.$match({
  Base: () => 0,
  Insert: () => 1,
  Transient: () => 2,
});

export interface ModeOptions {
  readonly name: string;
  /** Text that the HUD shows while the mode is live. */
  readonly indicator: Option.Option<string>;
  /** The events that end the mode. */
  readonly exitOn: ReadonlyArray<ExitTrigger>;
  readonly keyboard: KeyPolicy;
  /** Only one mode per group may be live. A second one exits the first. */
  readonly singleton: Option.Option<string>;
  /** Where the mode sits on the stack. A mode with no tier is transient. */
  readonly tier?: ModeTier;
}

/**
 * A live mode. Hold it to exit the mode, or to learn that it exited.
 *
 * The mode owns a scope of its own, inside the scope that entered it. The exit
 * closes that scope, and the close of the outer scope exits the mode. A mode
 * that ends therefore leaves nothing behind in the scope of its caller.
 */
export interface ModeHandle {
  readonly name: string;
  readonly isActive: Effect.Effect<boolean>;
  readonly exit: (reason?: ExitReason) => Effect.Effect<void>;
  /** Run `body` when the mode exits. It runs at once if it already exited. */
  readonly onExit: (body: (reason: ExitReason) => Effect.Effect<void>) => Effect.Effect<void>;
}

/**
 * Escape detection.
 *
 * `<c-[>` is an Escape synonym, as in Vim and in upstream Vimium. On a Mac
 * laptop with no physical Escape key it is the only comfortable way out.
 */
export const isEscape = (event: KeyboardEvent): boolean =>
  event.key === "Escape" || (event.ctrlKey && (event.key === "[" || event.code === "BracketLeft"));

/** The body of a mode for one event, with its services already supplied. */
type Body<K extends HandlerEventName> = (event: HandlerEventMap[K]) => Effect.Effect<HandlerResult>;

/** A body for every event. A mode answers the events that it does not handle as well. */
type Bodies = { readonly [K in HandlerEventName]: Body<K> };

/** A mode on the stack. */
interface LiveMode {
  readonly handle: ModeHandle;
  readonly tier: ModeTier;
  readonly indicator: Option.Option<string>;
  readonly bodies: Bodies;
}

interface ModeState {
  /** The stack, from the bottom to the top. */
  readonly active: ReadonlyArray<LiveMode>;
  /** The mode that holds each singleton group. */
  readonly singletons: Record.ReadonlyRecord<string, ModeHandle>;
}

type ExitBody = (reason: ExitReason) => Effect.Effect<void>;

/** The life of one mode. A mode that exited never comes back. */
type Life = Data.TaggedEnum<{
  /** The mode is live, and it holds the bodies that its exit runs. */
  Live: { readonly bodies: ReadonlyArray<ExitBody> };
  Exited: NoFields;
}>;
const Life = Data.taggedEnum<Life>();

const EXITED: Life = Life.Exited();

/**
 * Keep an exit body. A mode that already exited runs it at once instead.
 *
 * The answer is the effect to run now.
 */
const keptBody = (body: ExitBody): ((life: Life) => readonly [Effect.Effect<void>, Life]) =>
  Life.$match({
    Live: ({ bodies }): readonly [Effect.Effect<void>, Life] => [
      Effect.void,
      Life.Live({ bodies: pipe(bodies, Array.append(body)) }),
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

/** Put a mode above every mode of its tier, and below every mode of a higher tier. */
const placed =
  (mode: LiveMode) =>
  (active: ReadonlyArray<LiveMode>): ReadonlyArray<LiveMode> => {
    const [below, above] = pipe(
      active,
      Array.span((live) => rankOf(live.tier) <= rankOf(mode.tier)),
    );
    return pipe(below, Array.append(mode), Array.appendAll(above));
  };

/** Add a live mode. A mode in a singleton group takes the group. */
const joined =
  (mode: LiveMode, group: Option.Option<string>) =>
  ({ active, singletons }: ModeState): ModeState => ({
    active: pipe(active, placed(mode)),
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
  );

/** Is this mode still on the stack? */
const isOnStack =
  (mode: LiveMode) =>
  ({ active }: ModeState): boolean =>
    pipe(
      active,
      Array.some((live) => live === mode),
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

/** Do to the event what the answer of the stack says, and say whether it may go on to the page. */
const carryOut = (event: Event, result: HandlerResult): Effect.Effect<boolean> =>
  pipe(
    Match.value(result),
    Match.whenOr("continue", "pass-to-page", () => Effect.succeed(true)),
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
    Match.exhaustive,
  );

/** A key that the record of taken presses follows: a true key with a physical code. */
const tracked = (event: KeyboardEvent): boolean => isUserEvent(event) && event.code.length > 0;

/** Take `code` out of the record, and say whether it was there. */
const releaseOf =
  (code: string) =>
  (taken: HashSet.HashSet<string>): readonly [boolean, HashSet.HashSet<string>] => [
    HashSet.has(taken, code),
    HashSet.remove(taken, code),
  ];

export class Modes extends Context.Service<
  Modes,
  {
    /**
     * Enter a mode. It stays until it exits, or until the scope closes.
     *
     * The scope makes teardown structural. A feature that opens a mode inside its
     * own scope cannot leave the mode behind. A service that enters a mode again
     * and again for as long as its layer lives gives the layer scope, and holds
     * only the handle: each mode that ends takes its own scope with it.
     *
     * That scope holds the mode, and not the work of its bodies. A body runs
     * on each event with the services of the caller and without the scope, so
     * a body that acquires a resource makes its own scope. Read `Unscoped` in
     * `domain/Prelude.ts`.
     */
    readonly enter: <R>(
      options: ModeOptions,
      handlers?: Handlers<Unscoped<R>>,
    ) => Effect.Effect<ModeHandle, never, R | Scope.Scope>;

    /**
     * Exit every transient mode. For a navigation and for `pagehide`.
     *
     * Normal mode and insert mode stay. They belong to the page, and not to
     * what the user was doing on it.
     */
    readonly exitAll: (reason?: ExitReason) => Effect.Effect<void>;

    /**
     * Give each mode, from the top, a chance at the event.
     *
     * Answers `true` when the event may continue to the page.
     *
     * A `keyup` goes where its `keydown` went. The page gets the release of
     * a key exactly when it got the press, whatever the modes answer for the
     * release. The record of the presses that the page did not get is kept
     * here, where every key passes, and not in one mode. A mode above normal
     * mode takes the release of the key that opened it, `/` for find, and
     * macOS sends no release for a key pressed with ⌘. A record inside normal
     * mode went stale in both cases, and then took the next release of that
     * key from a text field of the page. An entry ends with the release of its
     * key, with a later press of that key that reaches the page, or with
     * `forgetSuppressed`. A key with no physical code is the exception: the
     * record cannot follow it, so the modes decide where its release goes.
     */
    readonly bubble: <K extends HandlerEventName>(
      name: K,
      event: HandlerEventMap[K],
    ) => Effect.Effect<boolean>;

    /**
     * Give the stack a press that the guard held while the application started.
     *
     * The walk is the one of `bubble`, and the record of the presses that the
     * page did not get stays as it is. The page never got this press, whatever
     * the modes answer now, and `withhold` took its release already.
     */
    readonly replay: (event: KeyboardEvent) => Effect.Effect<void>;

    /**
     * Keep the release of each of these keys from the page.
     *
     * For presses that the page did not get, and that `bubble` never saw: the
     * keys that the guard held, and that are still down when it lets go.
     */
    readonly withhold: (codes: HashSet.HashSet<string>) => Effect.Effect<void>;

    /** The indicator of the innermost live mode that has one. */
    readonly indicator: {
      readonly get: Effect.Effect<ModeIndicator>;
      /** The indicator now, and then every change of it. */
      readonly changes: Stream.Stream<ModeIndicator>;
    };

    /** The live mode names, innermost last. For diagnostics and for tests. */
    readonly activeNames: Effect.Effect<ReadonlyArray<string>>;

    /**
     * Forget which presses the page did not get.
     *
     * The window lost the focus, so a release may never come: the everyday
     * case is a window switch in the middle of a keystroke. The next release
     * of that physical key would otherwise be taken from a page that was
     * entitled to it.
     */
    readonly forgetSuppressed: Effect.Effect<void>;
  }
>()("vimium/core/Modes") {
  static readonly layer: Layer.Layer<Modes> = Layer.effect(
    Modes,
    Effect.gen(function* () {
      const state = yield* Ref.make<ModeState>({ active: [], singletons: Record.empty() });
      const indicator = yield* SubscriptionRef.make<ModeIndicator>(Option.none());
      // The `event.code` of each key whose last press the page did not get.
      // It is keyed on `code` and not on `key`, because the modifier state can
      // change between the press and the release. Read `bubble`.
      const taken = yield* Ref.make(HashSet.empty<string>());

      /** A press that the page got gives it the release too, and one that it did not, not. */
      const notePress = (event: KeyboardEvent, toPage: boolean): Effect.Effect<boolean> =>
        pipe(
          tracked(event),
          Boolean.match({
            onFalse: () => Effect.void,
            onTrue: () =>
              pipe(
                taken,
                Ref.update(toPage ? HashSet.remove(event.code) : HashSet.add(event.code)),
              ),
          }),
          Effect.as(toPage),
        );

      /**
       * The release goes where its press went, whatever the modes answer.
       *
       * A mode may watch the release of a press that the page got, but it
       * cannot keep it: the page would then believe that the key is still
       * down. A Shift held through `O` was such a key. The record cannot
       * follow a key with no physical code, so the modes decide for it.
       *
       * A release that the page did not get stops, and keeps its default
       * action. Space activates a focused button or checkbox on its release,
       * so a dialog that let the press through needs that action, and a
       * press that normal mode took was prevented already, so its release
       * has no action to give.
       */
      const settleRelease = (event: KeyboardEvent, result: HandlerResult): Effect.Effect<boolean> =>
        pipe(
          tracked(event),
          Boolean.match({
            onFalse: () => carryOut(event, result),
            onTrue: () =>
              pipe(
                taken,
                Ref.modify(releaseOf(event.code)),
                Effect.flatMap(
                  Boolean.match({
                    onFalse: () => Effect.succeed(true),
                    onTrue: () => carryOut(event, SUPPRESS_PROPAGATION),
                  }),
                ),
              ),
          }),
        );

      /** What the record of taken presses makes of the answer of the modes. */
      const settle: {
        readonly [K in HandlerEventName]: (
          event: HandlerEventMap[K],
          result: HandlerResult,
        ) => Effect.Effect<boolean>;
      } = {
        keydown: (event, result) =>
          pipe(
            carryOut(event, result),
            Effect.flatMap((toPage) => notePress(event, toPage)),
          ),
        keypress: carryOut,
        keyup: settleRelease,
        click: carryOut,
        focus: carryOut,
        blur: carryOut,
      };

      /** Show the innermost indicator that a live mode gives. */
      const refreshIndicator = pipe(
        Ref.get(state),
        Effect.map(innermostIndicator),
        Effect.flatMap((shown) => pipe(indicator, SubscriptionRef.set(shown))),
      );

      const enter = <R>(
        options: ModeOptions,
        handlers: Handlers<Unscoped<R>> = {},
      ): Effect.Effect<ModeHandle, never, R | Scope.Scope> =>
        Effect.gen(function* () {
          const group = options.singleton;
          const life = yield* Ref.make<Life>(Life.Live({ bodies: [] }));
          const owner = yield* Scope.Scope;
          const scope = yield* Scope.fork(owner);

          const close = Effect.fnUntraced(function* (
            bodies: ReadonlyArray<ExitBody>,
            reason: ExitReason,
          ) {
            yield* pipe(state, Ref.update(left(handle, group)));
            // One body that fails must not keep the others from running.
            yield* pipe(
              bodies,
              Effect.forEach(
                (body) =>
                  pipe(
                    body(reason),
                    recoverEvenIfInterrupted(
                      `an exit body of the "${options.name}" mode`,
                      Effect.void,
                    ),
                  ),
                { discard: true },
              ),
            );
            yield* refreshIndicator;
            // The mode is gone, so its scope goes too, and the scope of the
            // caller no longer holds it.
            yield* Scope.close(scope, Exit.void);
          });

          const exit = (reason: ExitReason = "explicit"): Effect.Effect<void> =>
            pipe(
              life,
              Ref.getAndSet(EXITED),
              Effect.flatMap(
                Life.$match({
                  Live: ({ bodies }) => close(bodies, reason),
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

          // A singleton group holds one mode. Enter a second one, and the
          // first one exits.
          yield* pipe(
            Ref.get(state),
            Effect.map(holderOf(group)),
            Effect.flatMap(whenSome((previous) => previous.exit("singleton"))),
          );

          // The services of the bodies are captured once, so a body needs
          // nothing when the key path runs it.
          const bind = yield* bindServices<R>();

          const provided = <A extends Event>(
            body: ((event: A) => Effect.Effect<HandlerResult, never, Unscoped<R>>) | undefined,
          ): ((event: A) => Effect.Effect<Option.Option<HandlerResult>>) =>
            pipe(
              body,
              Option.fromUndefinedOr,
              Option.match({
                onNone: () => () => Effect.succeedNone,
                onSome: (run) => flow(run, Effect.asSome, bind),
              }),
            );

          /** The answer when a body gives none. */
          const answered =
            (unanswered: HandlerResult) =>
            <A extends Event>(body: (event: A) => Effect.Effect<Option.Option<HandlerResult>>) =>
              flow(body, Effect.map(Option.getOrElse(() => unanswered)));

          const keyEvent = pipe(
            options.keyboard,
            KeyPolicy.$match({ Shared: () => CONTINUE_BUBBLING, Owned: () => SUPPRESS_EVENT }),
            answered,
          );
          const other = answered(CONTINUE_BUBBLING);

          /** The exit for `reason`, when a trigger of the mode fires. */
          const exitWhen = (
            fires: (trigger: ExitTrigger) => boolean,
            reason: ExitReason,
          ): Effect.Effect<void> =>
            pipe(
              options.exitOn,
              Array.some(fires),
              Boolean.match({ onFalse: () => Effect.void, onTrue: () => exit(reason) }),
            );

          const keydown = keyEvent(provided(handlers.keydown));
          const click = other(provided(handlers.click));
          const focus = other(provided(handlers.focus));
          const escapeExits = pipe(options.exitOn, Array.some(ExitTrigger.$is("Escape")));
          const clickExit = exitWhen(ExitTrigger.$is("Click"), "click");
          const focusExit = exitWhen(ExitTrigger.$is("Focus"), "focus");

          const mode: LiveMode = {
            handle,
            tier: pipe(
              options.tier,
              Option.fromUndefinedOr,
              Option.getOrElse(() => ModeTier.Transient()),
            ),
            indicator: options.indicator,
            bodies: {
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
              keypress: keyEvent(provided(handlers.keypress)),
              keyup: keyEvent(provided(handlers.keyup)),
              click: (event) => pipe(clickExit, Effect.andThen(click(event))),
              focus: (event) => pipe(focusExit, Effect.andThen(focus(event))),
              blur: other(provided(handlers.blur)),
            },
          };

          yield* pipe(state, Ref.update(joined(mode, group)));
          yield* refreshIndicator;

          // The scope owns the mode. Nothing has to remember to exit it.
          yield* Scope.addFinalizer(scope, exit("navigation"));

          return handle;
        });

      const exitAll = (reason: ExitReason = "navigation"): Effect.Effect<void> =>
        pipe(
          Ref.get(state),
          Effect.flatMap(({ active }) =>
            pipe(
              active,
              Array.filter((mode) => ModeTier.$is("Transient")(mode.tier)),
              Array.reverse,
              Effect.forEach((mode) => mode.handle.exit(reason), { discard: true }),
            ),
          ),
        );

      /**
       * A mode that fails must not block the key path for the whole page. It
       * exits, which releases its singleton group, its indicator and the exit
       * bodies that hold the overlay of a feature, and the walk continues.
       */
      const dropDefective = (mode: LiveMode): Effect.Effect<HandlerResult> =>
        pipe(
          mode.handle.exit("defect"),
          recoverEvenIfInterrupted(`the exit of the "${mode.handle.name}" mode`, Effect.void),
          Effect.as(CONTINUE_BUBBLING),
        );

      /**
       * Walk the stack with the event, and give the answer of the mode that
       * decided. With no such mode, the event goes on to the page.
       */
      const dispatch = <K extends HandlerEventName>(
        name: K,
        event: HandlerEventMap[K],
      ): Effect.Effect<HandlerResult> => {
        /**
         * The answer of one mode of the snapshot.
         *
         * The snapshot is fixed. The stack is not. A mode that left the stack
         * after the snapshot must not still see the event.
         */
        const answer = (mode: LiveMode): Effect.Effect<HandlerResult> =>
          pipe(
            Ref.get(state),
            Effect.map(isOnStack(mode)),
            Effect.flatMap(
              Boolean.match({
                onFalse: () => Effect.succeed(CONTINUE_BUBBLING),
                onTrue: () =>
                  pipe(
                    event,
                    pipe(mode.bodies, Struct.get(name)),
                    recoverEvenIfInterrupted(
                      `the "${mode.handle.name}" mode during ${name}`,
                      dropDefective(mode),
                    ),
                  ),
              }),
            ),
          );

        /** Give the event to each mode, from the top, until one decides. */
        const walk: (modes: ReadonlyArray<LiveMode>) => Effect.Effect<HandlerResult> =
          Array.matchRight({
            onEmpty: () => Effect.succeed(PASS_EVENT_TO_PAGE),
            onNonEmpty: (below, mode) =>
              pipe(
                answer(mode),
                Effect.filterOrElse(
                  (result) => result !== CONTINUE_BUBBLING,
                  () => walk(below),
                ),
              ),
          });

        /**
         * A real snapshot. Modes enter and exit while the walk is in progress,
         * and indexing into the live array while it changes skips frames: a
         * mode that exited moved every mode below it up by one, so the next step
         * went over one of them.
         */
        return pipe(
          Ref.get(state),
          Effect.flatMap(({ active }) => walk(active)),
        );
      };

      const bubble = <K extends HandlerEventName>(
        name: K,
        event: HandlerEventMap[K],
      ): Effect.Effect<boolean> =>
        pipe(
          dispatch(name, event),
          Effect.flatMap((result) => settle[name](event, result)),
        );

      return Modes.of({
        enter,
        exitAll,
        bubble,
        replay: (event) =>
          pipe(
            dispatch("keydown", event),
            Effect.flatMap((result) => carryOut(event, result)),
            Effect.asVoid,
          ),
        withhold: (codes) => pipe(taken, Ref.update(HashSet.union(codes))),
        indicator: {
          get: SubscriptionRef.get(indicator),
          changes: SubscriptionRef.changes(indicator),
        },
        activeNames: pipe(
          Ref.get(state),
          Effect.map(({ active }) =>
            pipe(
              active,
              Array.map((mode) => mode.handle.name),
            ),
          ),
        ),
        forgetSuppressed: pipe(taken, Ref.set(HashSet.empty<string>())),
      });
    }),
  );
}
