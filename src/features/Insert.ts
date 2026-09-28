/**
 * Insert mode.
 *
 * Ported from upstream Vimium's `content_scripts/mode_insert.js` (MIT).
 *
 * Two flavours, as upstream: *element* insert mode, entered without a command
 * when an editable element takes focus, and *global* insert mode, entered with
 * `i`. Both give every key to the page, except Escape.
 *
 * The old version told the HUD to show the indicator. This one does not, and it
 * must not: a feature does not speak to the user interface, and the HUD reads
 * the indicator of the mode stack. Insert mode therefore opens a second, empty
 * mode frame whose only content is the indicator, and closes it again when the
 * user stops typing.
 */

import {
  Array,
  Boolean,
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Scope,
  Struct,
  flow,
  pipe,
} from "effect";
import { constVoid } from "effect/Function";
import { Commands } from "~/core/Commands.ts";
import {
  CONTINUE_BUBBLING,
  type HandlerResult,
  PASS_EVENT_TO_PAGE,
  SUPPRESS_EVENT,
} from "~/core/HandlerStack.ts";
import { isEscape, KeyPolicy, type ModeHandle, Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { Dom } from "~/platform/Dom.ts";
import { deepActiveElement } from "~/platform/Elements.ts";

/** What the HUD shows while the user types. */
const INSERT_INDICATOR = "Insert mode";

const EDITABLE_INPUT_TYPES: ReadonlyArray<string> = [
  "text",
  "search",
  "email",
  "url",
  "number",
  "password",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
  "tel",
];

const isHTMLElement = (node: EventTarget | null): node is HTMLElement =>
  node instanceof HTMLElement;

/**
 * Can the user type into this element *now*?
 *
 * This is a stricter question than `isEditable` in `~/platform/Elements.ts`.
 * That one asks whether a node is a text-entry element, which is what the boot
 * guard needs. Insert mode must also respect `disabled`, `readOnly` and the
 * type of the input: a page that gives every key to a disabled field costs the
 * user every command.
 */
const acceptsTyping = (element: HTMLElement): boolean =>
  element.isContentEditable ||
  (element instanceof HTMLTextAreaElement && !element.disabled && !element.readOnly) ||
  (element instanceof HTMLSelectElement && !element.disabled) ||
  (element instanceof HTMLInputElement &&
    !element.disabled &&
    !element.readOnly &&
    pipe(EDITABLE_INPUT_TYPES, Array.contains(element.type.toLowerCase())));

/** The node, when it is an element that the user can type into now. */
const typingTarget: (node: EventTarget | null) => Option.Option<HTMLElement> = flow(
  Option.liftPredicate(isHTMLElement),
  Option.filter(acceptsTyping),
);

/**
 * The tag of our own overlay host.
 *
 * Our HUD and omnibar inputs live in the focus tree of the page, because a
 * userscript has no extension-origin iframe (§6.3). Focus into one of them must
 * not start insert mode. The overlay uses a closed shadow root, so an event
 * that starts inside it is retargeted to the host before any window listener
 * sees it. The tag of the target is therefore the whole test.
 *
 * The test is here, and not a call to the HUD. A feature does not depend on the
 * user interface, and the HUD is built above this service.
 */
const OVERLAY_TAG = "vimium-webkit-overlay";

const ownsFocus = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(OVERLAY_TAG) !== null;

/** The element that a focus gives the keys to. Our own overlay never takes them. */
const adoptable: (node: EventTarget | null) => Option.Option<HTMLElement> = flow(
  Option.liftPredicate(Predicate.not(ownsFocus)),
  Option.flatMap(typingTarget),
);

/**
 * The node that the event truly started at.
 *
 * A `focus` or a `blur` inside a shadow root is retargeted to the host before
 * any window listener sees it. `event.target` therefore names the host, and not
 * the field. A page that keeps its search box in a web component looked
 * unfocused. Every key that the user typed into it ran a command.
 *
 * `composedPath()[0]` is the true node while the root is open. A closed root
 * gives the host, which is the correct answer there and is what our own
 * overlay needs.
 */
export const composedTarget = (event: Pick<Event, "composedPath" | "target">): EventTarget | null =>
  pipe(
    event.composedPath(),
    Array.head,
    Option.getOrElse(() => event.target),
  );

/** An element with no box at all is not on the screen. */
const hasBox = (element: Element): boolean => {
  const { width, height } = element.getBoundingClientRect();
  return width !== 0 || height !== 0;
};

const isRendered = (style: CSSStyleDeclaration): boolean =>
  style.visibility !== "hidden" && style.display !== "none";

const isVisible = (view: Window, element: Element): boolean =>
  hasBox(element) && isRendered(view.getComputedStyle(element));

const NO_ELEMENTS: ReadonlyArray<Element> = [];

/** Every element below a root, with the elements of each open shadow root after its host. */
const deepElements = (root: ParentNode): ReadonlyArray<Element> =>
  pipe(
    root.querySelectorAll("*"),
    Array.fromIterable,
    Array.flatMap((element) => [element, ...shadowElements(element.shadowRoot)]),
  );

/**
 * Every element below an open shadow root. A closed root, or none, gives none.
 *
 * The match is built once, and not for each element, because the walk asks it
 * about every element of the page.
 */
const shadowElements: (shadow: ShadowRoot | null) => ReadonlyArray<Element> = flow(
  Option.fromNullOr,
  Option.match({ onNone: () => NO_ELEMENTS, onSome: deepElements }),
);

/** Every text-entry target that `gi` may choose, in document order. */
const focusableInputs = (view: Window, root: ParentNode): ReadonlyArray<HTMLElement> =>
  pipe(
    root,
    deepElements,
    Array.filter(isHTMLElement),
    Array.filter((element) => acceptsTyping(element) && isVisible(view, element)),
  );

/** The input that a count names: the first without a count, and the last past the end. */
const nthInput = (
  inputs: Array.NonEmptyReadonlyArray<HTMLElement>,
  count: number,
): Option.Option<HTMLElement> =>
  pipe(inputs, Array.get(Math.min(Math.max(1, count), inputs.length) - 1));

const isTextField = (element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;

/** The caret goes to the end, as upstream does. */
const caretToEnd = (field: HTMLInputElement | HTMLTextAreaElement): void => {
  const end = field.value.length;
  field.setSelectionRange(end, end);
};

interface InsertState {
  /** The element that has focus, when it is one that we gave the keys to. */
  readonly element: Option.Option<HTMLElement>;
  /** Global insert mode: every key goes to the page, whatever has focus. */
  readonly global: boolean;
}

/** Nobody is typing. */
const IDLE: InsertState = { element: Option.none(), global: false };

export class Insert extends Context.Service<
  Insert,
  {
    /** `i` — global insert mode, whatever has focus. */
    readonly enter: Effect.Effect<void>;

    readonly exit: Effect.Effect<void>;

    /** Is the user typing into something? */
    readonly isActive: Effect.Effect<boolean>;

    /** `gi` — focus a text input. */
    readonly focusInput: (count: number) => Effect.Effect<void>;

    /** Learn what already has focus. Call it before any listener is attached. */
    readonly seedFromFocus: Effect.Effect<void>;

    /** Give the focus back to the page, unless the user is already typing. */
    readonly grabBackFocus: (userHasTyped: boolean) => Effect.Effect<void>;

    /** Keep insert mode entered while the exclusion allows it. */
    readonly ensureEntered: Effect.Effect<void>;
  }
>()("vimium/features/Insert") {
  static readonly layer: Layer.Layer<Insert, never, Commands | Dom | Modes | Report | Settings> =
    Layer.effect(
      Insert,
      Effect.gen(function* () {
        const commands = yield* Commands;
        const dom = yield* Dom;
        const modes = yield* Modes;
        const report = yield* Report;
        const settings = yield* Settings;

        const state = yield* Ref.make<InsertState>(IDLE);
        const base = yield* Ref.make(Option.none<ModeHandle>());
        const badge = yield* Ref.make(Option.none<ModeHandle>());

        // Both frames belong to the layer scope, which exits them when the
        // runtime stops. Each one owns a scope inside it, so a frame that
        // `ensureEntered` replaces leaves nothing behind there.
        const layerScope = yield* Scope.Scope;

        const isOpen = (cell: Ref.Ref<Option.Option<ModeHandle>>): Effect.Effect<boolean> =>
          pipe(
            Ref.get(cell),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(false),
                onSome: (handle) => handle.isActive,
              }),
            ),
          );

        const closeFrame: (cell: Ref.Ref<Option.Option<ModeHandle>>) => Effect.Effect<void> = flow(
          Ref.getAndSet(Option.none<ModeHandle>()),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (handle) => handle.exit("explicit"),
            }),
          ),
        );

        /** Open a mode frame in the layer scope, and keep its handle in the cell. */
        const openFrame = Effect.fnUntraced(function* (
          cell: Ref.Ref<Option.Option<ModeHandle>>,
          enter: Effect.Effect<ModeHandle, never, Scope.Scope>,
        ) {
          const handle = yield* pipe(enter, Scope.provide(layerScope));
          yield* pipe(cell, Ref.set(Option.some(handle)));
        });

        /** Open the frame again, unless the cell holds one that is still live. */
        const ensureFrame = Effect.fnUntraced(function* (
          cell: Ref.Ref<Option.Option<ModeHandle>>,
          enter: Effect.Effect<ModeHandle, never, Scope.Scope>,
        ) {
          const open = yield* isOpen(cell);
          yield* pipe(
            open,
            Boolean.match({ onFalse: () => openFrame(cell, enter), onTrue: () => Effect.void }),
          );
        });

        const isInserting = pipe(
          Ref.get(state),
          Effect.map((current) => current.global || Option.isSome(current.element)),
        );

        /**
         * Show the indicator, as a mode frame of its own.
         *
         * The frame carries no handler. It exists so that the indicator takes
         * part in the mode stack: a mode that opens above insert mode owns the
         * indicator while it lives, and insert mode gets it back afterwards.
         */
        const showIndicator = Effect.fn("Insert.showIndicator")(function* () {
          yield* ensureFrame(
            badge,
            modes.enter<never>({
              name: "insert-indicator",
              indicator: Option.some(INSERT_INDICATOR),
              exitOn: [],
              keyboard: KeyPolicy.Shared(),
              singleton: Option.some("insert-indicator"),
            }),
          );
        });

        const hideIndicator = closeFrame(badge);

        /** Give the keys to an element that has the focus. */
        const adopt = (element: HTMLElement): Effect.Effect<void> =>
          pipe(
            state,
            Ref.update(Struct.assign({ element: Option.some(element) })),
            Effect.andThen(showIndicator()),
          );

        /** The page may have detached the element already. */
        const blurElement = (element: HTMLElement): Effect.Effect<void> =>
          pipe(
            dom.attempt("HTMLElement.blur", () => {
              element.blur();
            }),
            Effect.ignore,
          );

        /** A key while the user types. */
        const typedKey = (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
          pipe(
            isEscape(event),
            Boolean.match({
              // `PASS_EVENT_TO_PAGE`, and not `CONTINUE_BUBBLING`: normal mode is
              // below us on the stack, and it must not see the keystroke.
              onFalse: () => Effect.succeed(PASS_EVENT_TO_PAGE),
              // Suppressed: many pages read Escape as "close this widget", and a
              // user who presses Escape to leave insert mode does not ask for
              // that.
              onTrue: () => pipe(exitInsert(), Effect.as(SUPPRESS_EVENT)),
            }),
          );

        const onKeydown = (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
          pipe(
            isInserting,
            Effect.flatMap(
              Boolean.match({
                onFalse: () => Effect.succeed(CONTINUE_BUBBLING),
                onTrue: () => typedKey(event),
              }),
            ),
          );

        /**
         * The focused node, through an open shadow root.
         *
         * `composedPath` is a call on an object that the page made, so it goes
         * through the probe. A page that replaces it with an accessor that throws
         * must cost us the shadow case only, and not the whole handler.
         */
        const focusedNode = (event: FocusEvent): Effect.Effect<EventTarget | null> =>
          dom.probeOrElse(
            () => composedTarget(event),
            () => event.target,
          );

        const onFocus = Effect.fnUntraced(function* (event: FocusEvent) {
          const target = yield* focusedNode(event);
          yield* pipe(
            adoptable(target),
            Option.match({ onNone: () => Effect.void, onSome: adopt }),
          );
          return CONTINUE_BUBBLING;
        });

        /** The element that had the keys lost the focus. Global insert mode keeps its indicator. */
        const leave = Effect.fnUntraced(function* (current: InsertState) {
          const left: InsertState = pipe(current, Struct.assign({ element: Option.none() }));
          yield* pipe(state, Ref.set(left));
          yield* pipe(
            current.global,
            Boolean.match({ onFalse: () => hideIndicator, onTrue: () => Effect.void }),
          );
        });

        const onBlur = Effect.fnUntraced(function* (event: FocusEvent) {
          const current = yield* Ref.get(state);
          // The same rule as the focus above. The blur of a field inside an
          // open shadow root names the host, so a compare against
          // `event.target` never matched. Insert mode then stayed on after the
          // field went away.
          const target = yield* focusedNode(event);
          yield* pipe(
            current.element,
            Option.filter((element) => element === target),
            Option.match({ onNone: () => Effect.void, onSome: () => leave(current) }),
          );
          return CONTINUE_BUBBLING;
        });

        /**
         * Make sure that the stack frame of insert mode is live.
         *
         * A soft navigation exits every mode, and this service survives it. The
         * frame must therefore be reachable again from outside, because nothing
         * builds the service a second time (CORE-01).
         */
        const ensureEntered = Effect.fn("Insert.ensureEntered")(function* () {
          yield* ensureFrame(
            base,
            modes.enter(
              {
                name: "insert",
                indicator: Option.none(),
                exitOn: [],
                keyboard: KeyPolicy.Shared(),
                singleton: Option.some("insert"),
              },
              {
                keydown: onKeydown,
                focus: onFocus,
                blur: onBlur,
              },
            ),
          );
        });

        const enterGlobal = Effect.fn("Insert.enter")(function* () {
          yield* ensureEntered();
          yield* pipe(state, Ref.update(Struct.assign({ global: true })));
          yield* showIndicator();
        });

        const exitInsert = Effect.fn("Insert.exit")(function* () {
          const current = yield* pipe(state, Ref.getAndSet(IDLE));
          yield* pipe(
            current.element,
            Option.match({ onNone: () => Effect.void, onSome: blurElement }),
          );
          yield* hideIndicator;
        });

        /** Focus an input, and give it the keys. */
        const focusElement = Effect.fnUntraced(function* (target: HTMLElement) {
          yield* pipe(
            dom.attempt("HTMLElement.focus", () => {
              target.focus({ preventScroll: false });
              // `setSelectionRange` fails on an input type that does not
              // support it, and the focus above still holds.
              pipe(
                target,
                Option.liftPredicate(isTextField),
                Option.match({ onNone: constVoid, onSome: caretToEnd }),
              );
            }),
            Effect.ignore,
          );
          yield* adopt(target);
        });

        const focusNth: (target: Option.Option<HTMLElement>) => Effect.Effect<void> = Option.match({
          onNone: () => Effect.void,
          onSome: focusElement,
        });

        /**
         * Choose among the inputs.
         *
         * More than one input, and no count to choose between them. Upstream
         * shows hints on the inputs, and so do we. The hints service is asked by
         * name through the registry: a feature must never import another
         * feature. A build with no hints answers "unavailable", and the count
         * path runs instead.
         */
        const chooseInput = (
          inputs: Array.NonEmptyReadonlyArray<HTMLElement>,
          count: number,
        ): Effect.Effect<void> =>
          pipe(
            inputs.length > 1 && count <= 1,
            Boolean.match({
              onFalse: () => focusNth(nthInput(inputs, count)),
              onTrue: () =>
                pipe(
                  commands.run("LinkHints.activateModeToFocus", {
                    count: 1,
                    options: {},
                    event: Option.none(),
                  }),
                  Effect.catch(() => focusNth(nthInput(inputs, count))),
                ),
            }),
          );

        /**
         * `gi` — focus a text input.
         *
         * With a count, go straight to the nth input. When several inputs match
         * and there is no count, the hints choose, through the registry.
         */
        const focusInput = Effect.fn("Insert.focusInput")(function* (count: number) {
          const inputs = yield* dom.probeOrElse(
            () => focusableInputs(dom.window, dom.document),
            Array.empty,
          );
          yield* pipe(
            inputs,
            Array.match({
              onEmpty: () => report.info("No text inputs on this page"),
              onNonEmpty: (found) => chooseInput(found, count),
            }),
          );
        });

        /**
         * Adopt whatever already has focus.
         *
         * Insert mode otherwise learns about focus from live `focus` events only,
         * and the application starts long after the page has focused its search
         * box. On DuckDuckGo, on most login pages, and on anything with
         * `<input autofocus>`, the first keystrokes of the user were read as
         * commands (OSU-02).
         */
        const seedFromFocus = Effect.fn("Insert.seedFromFocus")(function* () {
          yield* pipe(
            dom.document,
            deepActiveElement,
            adoptable,
            Option.match({ onNone: () => Effect.void, onSome: adopt }),
          );
        });

        /** Blur the field that the page focused, and take the keys back from it. */
        const giveBack = Effect.fnUntraced(function* (field: HTMLElement) {
          yield* blurElement(field);
          yield* pipe(state, Ref.update(Struct.assign({ element: Option.none<HTMLElement>() })));
          yield* hideIndicator;
        });

        /**
         * `grabBackFocus`: some pages take the focus into a search box on load,
         * which swallows the first keystrokes of the user. Blur it once, and only
         * once, and only while the user has not typed.
         *
         * The typing guard carries weight, and it is not decoration. In the top
         * frame the application starts up to 1200 ms after load, and the boot
         * guard deliberately stays asleep for a keystroke that is aimed at an
         * editable element. Without the guard the field is taken away from a user
         * who is already a second into a query.
         */
        const grabBackFocus = Effect.fn("Insert.grabBackFocus")(function* (userHasTyped: boolean) {
          // The setting is read here, so that one place decides it.
          const wanted = !userHasTyped && settings.currentUnsafe().grabBackFocus;
          yield* pipe(
            wanted,
            Boolean.match({
              onFalse: () => Option.none<HTMLElement>(),
              onTrue: () => pipe(dom.document, deepActiveElement, typingTarget),
            }),
            Option.match({ onNone: () => Effect.void, onSome: giveBack }),
          );
        });

        // The base frame belongs to the layer scope. A caller that survives a
        // navigation uses `ensureEntered` to open it again.
        yield* ensureEntered();

        const service = Insert.of({
          enter: enterGlobal(),
          exit: exitInsert(),
          isActive: isInserting,
          focusInput,
          seedFromFocus: seedFromFocus(),
          grabBackFocus,
          ensureEntered: ensureEntered(),
        });

        yield* commands.registerAll({
          enterInsertMode: () => service.enter,
          focusInput: ({ count }) => service.focusInput(count),
        });

        return service;
      }),
    );
}
