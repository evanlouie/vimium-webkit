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

import { Context, Effect, Exit, Layer, Option, Ref, Scope } from "effect";
import { Commands } from "~/core/Commands.ts";
import {
  CONTINUE_BUBBLING,
  type HandlerResult,
  PASS_EVENT_TO_PAGE,
  SUPPRESS_EVENT,
} from "~/core/HandlerStack.ts";
import { isEscape, type ModeHandle, Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { Dom } from "~/platform/Dom.ts";
import { deepActiveElement } from "~/platform/Elements.ts";

/** What the HUD shows while the user types. */
const INSERT_INDICATOR = "Insert mode";

const EDITABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
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
]);

/**
 * Can the user type into this node *now*?
 *
 * This is a stricter question than `isEditable` in `~/platform/Elements.ts`.
 * That one asks whether a node is a text-entry element, which is what the boot
 * guard needs. Insert mode must also respect `disabled`, `readOnly` and the
 * type of the input: a page that gives every key to a disabled field costs the
 * user every command.
 */
const acceptsTyping = (node: EventTarget | null): node is HTMLElement => {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  if (node instanceof HTMLTextAreaElement) {
    return !node.disabled && !node.readOnly;
  }
  if (node instanceof HTMLSelectElement) return !node.disabled;
  if (node instanceof HTMLInputElement) {
    if (node.disabled || node.readOnly) return false;
    return EDITABLE_INPUT_TYPES.has(node.type.toLowerCase());
  }
  return false;
};

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
export const composedTarget = (event: Event): EventTarget | null => {
  const path = event.composedPath();
  return path[0] ?? event.target;
};

const isVisible = (view: Window, element: Element): boolean => {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = view.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
};

/** Every text-entry target that `gi` may choose, in document order. */
const focusableInputs = (
  view: Window,
  root: ParentNode,
): ReadonlyArray<HTMLElement> => {
  const found: HTMLElement[] = [];
  const walk = (scope: ParentNode): void => {
    for (const element of scope.querySelectorAll("*")) {
      if (acceptsTyping(element) && isVisible(view, element)) {
        found.push(element);
      }
      const shadow = element.shadowRoot;
      if (shadow) walk(shadow);
    }
  };
  walk(root);
  return found;
};

/** A live mode frame, and the scope that owns it. */
interface Frame {
  readonly scope: Scope.Closeable;
  readonly handle: ModeHandle;
}

interface InsertState {
  /** The element that has focus, when it is one that we gave the keys to. */
  readonly element: Option.Option<HTMLElement>;
  /** Global insert mode: every key goes to the page, whatever has focus. */
  readonly global: boolean;
}

export class Insert extends Context.Service<Insert, {
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
}>()("vimium/features/Insert") {
  static readonly layer: Layer.Layer<
    Insert,
    never,
    Commands | Dom | Modes | Report | Settings
  > = Layer.effect(
    Insert,
    Effect.gen(function*() {
      const commands = yield* Commands;
      const dom = yield* Dom;
      const modes = yield* Modes;
      const report = yield* Report;
      const settings = yield* Settings;

      const state = yield* Ref.make<InsertState>({
        element: Option.none(),
        global: false,
      });
      const base = yield* Ref.make<Option.Option<Frame>>(Option.none());
      const badge = yield* Ref.make<Option.Option<Frame>>(Option.none());

      const isOpen = (cell: Ref.Ref<Option.Option<Frame>>) =>
        Effect.gen(function*() {
          const frame = yield* Ref.get(cell);
          if (Option.isNone(frame)) return false;
          return yield* frame.value.handle.isActive;
        });

      const closeFrame = (cell: Ref.Ref<Option.Option<Frame>>) =>
        Effect.gen(function*() {
          const frame = yield* Ref.getAndSet(cell, Option.none());
          if (Option.isSome(frame)) {
            yield* Scope.close(frame.value.scope, Exit.void);
          }
        });

      const isInserting = Effect.map(
        Ref.get(state),
        (current) => current.global || Option.isSome(current.element),
      );

      /**
       * Show the indicator, as a mode frame of its own.
       *
       * The frame carries no handler. It exists so that the indicator takes
       * part in the mode stack: a mode that opens above insert mode owns the
       * indicator while it lives, and insert mode gets it back afterwards.
       */
      const showIndicator = Effect.fn("Insert.showIndicator")(function*() {
        if (yield* isOpen(badge)) return;
        yield* closeFrame(badge);
        const scope = yield* Scope.make();
        const handle = yield* Effect.provideService(
          modes.enter<never>({
            name: "insert-indicator",
            indicator: INSERT_INDICATOR,
            singleton: "insert-indicator",
          }),
          Scope.Scope,
          scope,
        );
        yield* Ref.set(badge, Option.some({ scope, handle }));
      });

      const hideIndicator = closeFrame(badge);

      const onKeydown = (
        event: KeyboardEvent,
      ): Effect.Effect<HandlerResult> =>
        Effect.gen(function*() {
          if (!(yield* isInserting)) return CONTINUE_BUBBLING;

          if (isEscape(event)) {
            yield* exitInsert();
            // Suppressed: many pages read Escape as "close this widget", and a
            // user who presses Escape to leave insert mode does not ask for
            // that.
            return SUPPRESS_EVENT;
          }
          // `PASS_EVENT_TO_PAGE`, and not `CONTINUE_BUBBLING`: normal mode is
          // below us on the stack, and it must not see the keystroke.
          return PASS_EVENT_TO_PAGE;
        });

      /**
       * The focused node, through an open shadow root.
       *
       * `composedPath` is a call on an object that the page made, so it goes
       * through the probe. A page that replaces it with an accessor that throws
       * must cost us the shadow case only, and not the whole handler.
       */
      const focusedNode = (
        event: FocusEvent,
      ): Effect.Effect<EventTarget | null> =>
        dom.probeOr(() => composedTarget(event), event.target);

      const onFocus = (event: FocusEvent): Effect.Effect<HandlerResult> =>
        Effect.gen(function*() {
          const target = yield* focusedNode(event);
          if (ownsFocus(target)) return CONTINUE_BUBBLING;
          if (acceptsTyping(target)) {
            yield* Ref.update(state, (current) => ({
              ...current,
              element: Option.some(target),
            }));
            yield* showIndicator();
          }
          return CONTINUE_BUBBLING;
        });

      const onBlur = (event: FocusEvent): Effect.Effect<HandlerResult> =>
        Effect.gen(function*() {
          const current = yield* Ref.get(state);
          // The same rule as the focus above. The blur of a field inside an
          // open shadow root names the host, so a compare against
          // `event.target` never matched. Insert mode then stayed on after the
          // field went away.
          const target = yield* focusedNode(event);
          if (
            Option.isNone(current.element) ||
            target !== current.element.value
          ) {
            return CONTINUE_BUBBLING;
          }
          yield* Ref.set(state, { ...current, element: Option.none() });
          if (!current.global) yield* hideIndicator;
          return CONTINUE_BUBBLING;
        });

      /**
       * Make sure that the stack frame of insert mode is live.
       *
       * A soft navigation exits every mode, and this service survives it. The
       * frame must therefore be reachable again from outside, because nothing
       * builds the service a second time (CORE-01).
       */
      const ensureEntered = Effect.fn("Insert.ensureEntered")(function*() {
        if (yield* isOpen(base)) return;
        yield* closeFrame(base);
        const scope = yield* Scope.make();
        const handle = yield* Effect.provideService(
          modes.enter({
            name: "insert",
            indicator: null,
            singleton: "insert",
          }, {
            keydown: onKeydown,
            focus: onFocus,
            blur: onBlur,
          }),
          Scope.Scope,
          scope,
        );
        yield* Ref.set(base, Option.some({ scope, handle }));
      });

      const enterGlobal = Effect.fn("Insert.enter")(function*() {
        yield* ensureEntered();
        yield* Ref.update(state, (current) => ({ ...current, global: true }));
        yield* showIndicator();
      });

      const exitInsert = Effect.fn("Insert.exit")(function*() {
        const current = yield* Ref.getAndSet(state, {
          element: Option.none(),
          global: false,
        });
        if (Option.isSome(current.element)) {
          const element = current.element.value;
          // The page may have detached the element already.
          yield* Effect.ignore(
            dom.attempt("HTMLElement.blur", () => {
              element.blur();
            }),
          );
        }
        yield* hideIndicator;
      });

      /**
       * `gi` — focus a text input.
       *
       * With a count, go straight to the nth input. There is no hand-off to
       * link hints when several inputs match: a feature does not call another
       * feature.
       */
      const focusInput = Effect.fn("Insert.focusInput")(
        function*(count: number) {
          const inputs = yield* dom.probeOr<ReadonlyArray<HTMLElement>>(
            () => focusableInputs(dom.window, dom.document),
            [],
          );
          if (inputs.length === 0) {
            yield* report.info("No text inputs on this page");
            return;
          }

          // More than one input, and no count to choose between them. Upstream
          // shows hints on the inputs, and so do we. The hints service is asked
          // by name through the registry: a feature must never import another
          // feature. A build with no hints answers "unavailable", and the count
          // path below still works.
          if (inputs.length > 1 && count <= 1) {
            const handedOver = yield* Effect.match(
              commands.run("LinkHints.activateModeToFocus", {
                count: 1,
                options: {},
                event: null,
              }),
              { onFailure: () => false, onSuccess: () => true },
            );
            if (handedOver) return;
          }

          const index = Math.min(Math.max(1, count), inputs.length) - 1;
          const target = inputs[index];
          if (target === undefined) return;

          yield* Effect.ignore(
            dom.attempt("HTMLElement.focus", () => {
              target.focus({ preventScroll: false });
              if (
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement
              ) {
                // The caret goes to the end, as upstream does.
                // `setSelectionRange` fails on an input type that does not
                // support it, and the focus above still holds.
                const end = target.value.length;
                target.setSelectionRange(end, end);
              }
            }),
          );

          yield* Ref.update(state, (current) => ({
            ...current,
            element: Option.some(target),
          }));
          yield* showIndicator();
        },
      );

      /**
       * Adopt whatever already has focus.
       *
       * Insert mode otherwise learns about focus from live `focus` events only,
       * and the application starts long after the page has focused its search
       * box. On DuckDuckGo, on most login pages, and on anything with
       * `<input autofocus>`, the first keystrokes of the user were read as
       * commands (OSU-02).
       */
      const seedFromFocus = Effect.fn("Insert.seedFromFocus")(function*() {
        const active = deepActiveElement(dom.document);
        if (ownsFocus(active)) return;
        if (!acceptsTyping(active)) return;
        yield* Ref.update(state, (current) => ({
          ...current,
          element: Option.some(active),
        }));
        yield* showIndicator();
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
      const grabBackFocus = Effect.fn("Insert.grabBackFocus")(
        function*(userHasTyped: boolean) {
          if (userHasTyped) return;
          // The setting is read here, so that one place decides it.
          if (!settings.currentUnsafe().grabBackFocus) return;
          const active = deepActiveElement(dom.document);
          if (!acceptsTyping(active)) return;
          yield* Effect.ignore(
            dom.attempt("HTMLElement.blur", () => {
              active.blur();
            }),
          );
          yield* Ref.update(state, (current) => ({
            ...current,
            element: Option.none(),
          }));
          yield* hideIndicator;
        },
      );

      // The base frame belongs to the layer scope. A caller that survives a
      // navigation uses `ensureEntered` to open it again.
      yield* ensureEntered();

      // Both frames live in a scope of their own, so that `ensureEntered` can
      // replace one. This gives them back to the layer scope, which closes
      // them when the runtime stops.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          yield* closeFrame(badge);
          yield* closeFrame(base);
        })
      );

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
