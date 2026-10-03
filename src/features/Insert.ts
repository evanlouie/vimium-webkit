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
 * the indicator of the mode stack. Element insert mode therefore opens a second,
 * empty mode frame whose only content is the indicator, and closes it again when
 * the user stops typing. Global insert mode is a mode of its own, and it carries
 * its own indicator.
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
import { isEscape, KeyPolicy, type ModeHandle, Modes, ModeTier } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { whenSome } from "~/domain/Prelude.ts";
import { Dom } from "~/platform/Dom.ts";
import { composedTarget, deepActiveElement, isHtmlElement } from "~/platform/Elements.ts";
import { Ui } from "~/ui/Ui.ts";

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
  Option.liftPredicate(isHtmlElement),
  Option.filter(acceptsTyping),
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
    Array.filter(isHtmlElement),
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

export class Insert extends Context.Service<
  Insert,
  {
    /** `i` — global insert mode, whatever has focus. */
    readonly enter: Effect.Effect<void>;

    /** `gi` — focus a text input. */
    readonly focusInput: (count: number) => Effect.Effect<void>;

    /** Learn what already has focus. Call it before any listener is attached. */
    readonly seedFromFocus: Effect.Effect<void>;

    /** Give the focus back to the page, unless the user is already typing. */
    readonly grabBackFocus: (userHasTyped: boolean) => Effect.Effect<void>;
  }
>()("vimium/features/Insert") {
  static readonly layer: Layer.Layer<
    Insert,
    never,
    Commands | Dom | Modes | Report | Settings | Ui
  > = Layer.effect(
    Insert,
    Effect.gen(function* () {
      const commands = yield* Commands;
      const dom = yield* Dom;
      const modes = yield* Modes;
      const report = yield* Report;
      const settings = yield* Settings;
      const ui = yield* Ui;

      /**
       * The element that a focus gives the keys to.
       *
       * Our HUD and omnibar inputs live in the focus tree of the page, because
       * a userscript has no extension-origin iframe. Focus into one of
       * them must not start insert mode.
       */
      const adoptable: (node: EventTarget | null) => Option.Option<HTMLElement> = flow(
        Option.liftPredicate(Predicate.not(ui.owns)),
        Option.flatMap(typingTarget),
      );

      /** The element that has focus, when it is one that we gave the keys to. */
      const field = yield* Ref.make(Option.none<HTMLElement>());
      /** The frame that shows the indicator while the user types into `field`. */
      const badge = yield* Ref.make(Option.none<ModeHandle>());
      /** Global insert mode. The live mode is the state, and it carries its own indicator. */
      const global = yield* Ref.make(Option.none<ModeHandle>());

      // Both frames belong to the layer scope, which exits them when the
      // application scope closes. Each one owns a scope inside that one, so a frame that
      // closes leaves nothing behind there.
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
        Effect.flatMap(whenSome((handle) => handle.exit("explicit"))),
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
            tier: ModeTier.Insert(),
          }),
        );
      });

      const hideIndicator = closeFrame(badge);

      /** Give the keys to an element that has the focus. */
      const adopt = (element: HTMLElement): Effect.Effect<void> =>
        pipe(field, Ref.set(Option.some(element)), Effect.andThen(showIndicator()));

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
          Ref.get(field),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(CONTINUE_BUBBLING),
              onSome: () => typedKey(event),
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
        yield* pipe(adoptable(target), whenSome(adopt));
        return CONTINUE_BUBBLING;
      });

      /** The element that had the keys lost the focus. */
      const leave = pipe(field, Ref.set(Option.none<HTMLElement>()), Effect.andThen(hideIndicator));

      const onBlur = Effect.fnUntraced(function* (event: FocusEvent) {
        const current = yield* Ref.get(field);
        // The same rule as the focus above. The blur of a field inside an
        // open shadow root names the host, so a compare against
        // `event.target` never matched. Insert mode then stayed on after the
        // field went away.
        const target = yield* focusedNode(event);
        yield* pipe(
          current,
          Option.filter((element) => element === target),
          whenSome(() => leave),
        );
        return CONTINUE_BUBBLING;
      });

      /**
       * `i` — global insert mode, as a mode of its own.
       *
       * While the mode is live, every key goes to the page and the HUD says
       * so. A navigation exits it as it exits every transient mode, and no
       * flag is left behind that still gives the keys away.
       */
      const enterGlobal = Effect.fn("Insert.enter")(function* () {
        yield* ensureFrame(
          global,
          modes.enter(
            {
              name: "insert-global",
              indicator: Option.some(INSERT_INDICATOR),
              exitOn: [],
              keyboard: KeyPolicy.Shared(),
              singleton: Option.none(),
            },
            { keydown: typedKey },
          ),
        );
      });

      /** Escape: stop typing, whichever insert mode had the keys. */
      const exitInsert = Effect.fn("Insert.exit")(function* () {
        yield* closeFrame(global);
        const typing = yield* pipe(field, Ref.getAndSet(Option.none<HTMLElement>()));
        yield* pipe(typing, whenSome(blurElement));
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

      const focusNth: (target: Option.Option<HTMLElement>) => Effect.Effect<void> =
        whenSome(focusElement);

      /**
       * Choose among the inputs.
       *
       * More than one input, and no count to choose between them. Upstream
       * shows hints on the inputs, and so do we. The hint command is run by
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
        yield* pipe(dom.document, deepActiveElement, adoptable, whenSome(adopt));
      });

      /** Blur the field that the page focused, and take the keys back from it. */
      const giveBack = Effect.fnUntraced(function* (element: HTMLElement) {
        yield* blurElement(element);
        yield* leave;
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
          whenSome(giveBack),
        );
      });

      // Insert mode lives as long as the layer. It sits above normal mode,
      // and a navigation leaves it there.
      yield* modes.enter(
        {
          name: "insert",
          indicator: Option.none(),
          exitOn: [],
          keyboard: KeyPolicy.Shared(),
          singleton: Option.none(),
          tier: ModeTier.Insert(),
        },
        {
          keydown: onKeydown,
          focus: onFocus,
          blur: onBlur,
        },
      );

      const service = Insert.of({
        enter: enterGlobal(),
        focusInput,
        seedFromFocus: seedFromFocus(),
        grabBackFocus,
      });

      yield* commands.registerAll({
        enterInsertMode: () => service.enter,
        focusInput: ({ count }) => service.focusInput(count),
      });

      return service;
    }),
  );
}
