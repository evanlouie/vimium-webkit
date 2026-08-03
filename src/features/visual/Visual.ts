/**
 * Visual mode, visual line mode and caret mode.
 *
 * Ported from the `content_scripts/mode_visual.js` of Vimium (MIT). The three
 * modes are one implementation with two flags:
 *
 * | mode        | `alterMethod` | line-wise |
 * | ----------- | ------------- | --------- |
 * | visual      | `"extend"`    | no        |
 * | visual line | `"extend"`    | yes       |
 * | caret       | `"move"`      | no        |
 *
 * `alterMethod` truly is the whole difference in meaning between visual mode
 * and caret mode. `"extend"` drags the focus and pins the anchor. `"move"`
 * drags both.
 *
 * One mode is live at a time. The three share the `visual` singleton group, so
 * `v` → `V` → `c` is a hand-over and not a stack. The hand-over exits the
 * mode before it with the reason `"singleton"`, which is what keeps the
 * selection: the selection is the state that is handed over.
 */

import { Context, Effect, Exit, Layer, Option, Ref, Scope } from "effect";
import { Commands } from "~/core/Commands.ts";
import { type HandlerResult, SUPPRESS_EVENT } from "~/core/HandlerStack.ts";
import { type ExitReason, type ModeHandle, Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import {
  appendCountDigit,
  isComposing,
  isCountDigit,
  keyNotation,
} from "~/domain/Key.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Clipboard } from "~/platform/Clipboard.ts";
import { Dom } from "~/platform/Dom.ts";
import { Hud } from "~/ui/Hud.ts";
import { Ui } from "~/ui/Ui.ts";
import {
  type AlterMethod,
  canModify,
  collapseToAnchor,
  collapseToFocus,
  extendByOneCharacter,
  extendToLines,
  findCaretAnchor,
  MOVEMENTS,
  type MovementSpec,
  readBoundaries,
  reverseSelection,
  runMovement,
  scrollSelectionIntoView,
  selectionText,
} from "./Movement.ts";

export type VisualKind = "visual" | "visual-line" | "caret";

const INDICATORS: Readonly<Record<VisualKind, string>> = {
  "visual": "Visual",
  "visual-line": "Visual line",
  "caret": "Caret",
};

/**
 * WebKit does not give a page the content of the clipboard outside its own
 * paste control, and a userscript cannot make a gesture that changes that. To
 * say so is better than a key that does nothing.
 */
const PASTE_EXPLANATION =
  "Paste is unavailable: WebKit only releases clipboard contents through its " +
  "own paste affordance. Use ⌘V (Ctrl+V).";

/** How long the explanation above stays on screen. */
const PASTE_EXPLANATION_MS = 4000;

const alterFor = (kind: VisualKind): AlterMethod =>
  kind === "caret" ? "move" : "extend";

/** A live mode, and the scope that owns it. */
interface LiveVisual {
  readonly kind: VisualKind;
  readonly scope: Scope.Closeable;
  readonly handle: ModeHandle;
}

export class Visual extends Context.Service<Visual, {
  readonly enterVisual: Effect.Effect<void>;
  readonly enterVisualLine: Effect.Effect<void>;
  readonly enterCaret: Effect.Effect<void>;
}>()("vimium/features/visual/Visual") {
  static readonly layer: Layer.Layer<
    Visual,
    never,
    | Dom
    | Ui
    | Hud
    | Settings
    | Modes
    | Commands
    | Report
    | Capabilities
    | Clipboard
  > = Layer.effect(
    Visual,
    Effect.gen(function*() {
      const dom = yield* Dom;
      const ui = yield* Ui;
      const hud = yield* Hud;
      const settings = yield* Settings;
      const modes = yield* Modes;
      const commands = yield* Commands;
      const report = yield* Report;
      const capabilities = yield* Capabilities;
      const clipboard = yield* Clipboard;

      const doc = dom.document;
      const win = dom.window;

      const live = yield* Ref.make<Option.Option<LiveVisual>>(Option.none());
      /** The count prefix that the user is typing. */
      const count = yield* Ref.make(0);
      /** `g` was pressed, and the next key completes the sequence. */
      const pendingG = yield* Ref.make(false);

      const selection: Effect.Effect<Option.Option<Selection>> = dom.probeOr(
        () => Option.fromNullishOr(win.getSelection()),
        Option.none<Selection>(),
      );

      /** Run one synchronous piece of selection work, and ignore a refusal. */
      const withSelection = (
        body: (selection: Selection) => void,
      ): Effect.Effect<void> =>
        Effect.gen(function*() {
          const target = yield* selection;
          if (Option.isNone(target)) return;
          yield* Effect.asVoid(dom.probeOr(() => {
            body(target.value);
            return true;
          }, false));
        });

      const clearSelection: Effect.Effect<void> = withSelection((target) => {
        // Nothing to do on a refusal. The page owns the selection again in
        // either case.
        target.removeAllRanges();
      });

      // -- the lifecycle of a mode ---------------------------------------

      /**
       * End the live mode, and close its scope.
       *
       * `reason` decides what happens to the selection. `"singleton"` is the
       * hand-over from `v` to `V` or to `c`, and the selection survives it.
       */
      const release = Effect.fn("Visual.release")(
        function*(reason: ExitReason) {
          const entry = yield* Ref.getAndSet(live, Option.none());
          if (Option.isNone(entry)) return;
          // The exit comes first, and with the true reason. Closing the scope
          // alone would exit the mode with `"navigation"`, and the hand-over
          // would then throw the selection away.
          yield* entry.value.handle.exit(reason);
          yield* Scope.close(entry.value.scope, Exit.void);
        },
      );

      /** End the live mode from inside one of its own key handlers. */
      const exitCurrent = Effect.fn("Visual.exitCurrent")(function*() {
        const entry = yield* Ref.get(live);
        if (Option.isSome(entry)) yield* entry.value.handle.exit("explicit");
      });

      const takeCount = Effect.gen(function*() {
        const value = yield* Ref.getAndSet(count, 0);
        return value > 0 ? value : 1;
      });

      // -- motions -------------------------------------------------------

      const runMotion = Effect.fn("Visual.runMotion")(
        function*(kind: VisualKind, spec: Option.Option<MovementSpec>) {
          const repeat = yield* takeCount;
          if (Option.isNone(spec)) return;
          const viewport = yield* ui.viewport;
          const alter = alterFor(kind);

          yield* withSelection((target) => {
            if (alter === "move") {
              // Caret mode: fold the display selection of one character away
              // first, so that the move starts at the caret and not at its far
              // end.
              collapseToAnchor(target);
              runMovement(target, "move", spec.value, repeat);
              extendByOneCharacter(target);
            } else {
              runMovement(target, "extend", spec.value, repeat);
              if (kind === "visual-line") extendToLines(target);
            }
            scrollSelectionIntoView(target, viewport);
          });
        },
      );

      const swapEnds = Effect.fn("Visual.swapEnds")(function*() {
        yield* Ref.set(count, 0);
        const viewport = yield* ui.viewport;
        yield* withSelection((target) => {
          reverseSelection(target);
          scrollSelectionIntoView(target, viewport);
        });
      });

      // -- yank ----------------------------------------------------------

      /**
       * `y`: copy the selection and leave.
       *
       * The write is started **inside** the keydown task. Nothing may suspend
       * in front of it: the window of transient activation in WebKit is short,
       * and the first suspension spends it, after which
       * `navigator.clipboard.writeText` refuses.
       *
       * `Effect.forkDetach` with `startImmediately` is what keeps that true.
       * The child fiber runs on this stack until it suspends, so the manager
       * write and the start of the promise both happen inside the dispatch of
       * the browser. Only the wait for the answer runs later.
       */
      const yank = Effect.fn("Visual.yank")(function*() {
        yield* Ref.set(count, 0);
        const target = yield* selection;
        const text = Option.isNone(target)
          ? ""
          : yield* dom.probeOr(() => selectionText(target.value), "");

        if (text.length === 0) {
          yield* hud.show("Nothing to copy");
          yield* exitCurrent();
          return;
        }

        yield* Effect.asVoid(Effect.forkDetach(
          Effect.catch(
            clipboard.write(text),
            (error) => report.error(`Copy failed: ${error.detail}`),
          ),
          { startImmediately: true },
        ));

        yield* hud.show(
          `Yanked ${text.length} character${text.length === 1 ? "" : "s"}`,
        );
        yield* exitCurrent();
      });

      // -- keys ----------------------------------------------------------

      const handleKey = Effect.fn("Visual.handleKey")(
        function*(kind: VisualKind, notation: string) {
          if (yield* Ref.getAndSet(pendingG, false)) {
            if (notation === "g") {
              yield* runMotion(kind, Option.fromNullishOr(MOVEMENTS.get("gg")));
              return;
            }
            // Fall through: `gj` is not a binding, but `g` and then a true
            // motion must still run that motion instead of being swallowed.
          }

          if (isCountDigit(notation, (yield* Ref.get(count)) > 0)) {
            // The rule of Vim: `0` is a motion, except while a count is being
            // typed. The count has a limit, because these modes suppress every
            // keyboard event, so an unlimited `999999999j` was a freeze that
            // Escape could not end.
            yield* Ref.update(
              count,
              (value) => appendCountDigit(value, notation),
            );
            return;
          }

          if (notation === "g") {
            yield* Ref.set(pendingG, true);
            return;
          }

          const movement = MOVEMENTS.get(notation);
          if (movement !== undefined) {
            yield* runMotion(kind, Option.some(movement));
            return;
          }

          switch (notation) {
            case "y":
              yield* yank();
              return;
            case "o":
              yield* swapEnds();
              return;
            case "c":
              yield* Ref.set(count, 0);
              yield* enterKind("caret");
              return;
            case "v":
              yield* Ref.set(count, 0);
              yield* enterKind("visual");
              return;
            case "V":
              yield* Ref.set(count, 0);
              yield* enterKind("visual-line");
              return;
            case "p":
            case "P":
              yield* Ref.set(count, 0);
              yield* hud.show(PASTE_EXPLANATION, PASTE_EXPLANATION_MS);
              return;
            default:
              yield* Ref.set(count, 0);
              return;
          }
        },
      );

      const onKeydown =
        (kind: VisualKind) =>
        (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
          Effect.gen(function*() {
            // A keystroke in the middle of a composition belongs to the input
            // method, and not to us.
            if (isComposing(event)) return SUPPRESS_EVENT;
            const notation = keyNotation(
              event,
              {
                ignoreKeyboardLayout:
                  settings.currentUnsafe().ignoreKeyboardLayout,
                applePlatform: capabilities.applePlatform,
              },
            );
            if (Option.isNone(notation)) return SUPPRESS_EVENT;
            yield* handleKey(kind, notation.value);
            return SUPPRESS_EVENT;
          });

      // -- the first selection -------------------------------------------

      /**
       * Establish the selection that the mode starts from.
       *
       * A selection that is already there is adopted, and not replaced. That is
       * what makes `v` after a find, or after a drag with the mouse, do the
       * obvious thing.
       */
      const start = Effect.fn("Visual.start")(function*(kind: VisualKind) {
        const target = yield* selection;
        const usable = Option.isSome(target) &&
          (yield* dom.probeOr(() => canModify(target.value), false));
        if (!usable || Option.isNone(target)) {
          yield* report.error("Text selection is not available in this frame.");
          yield* exitCurrent();
          return;
        }
        const current = target.value;

        const empty = yield* dom.probeOr(
          () => current.rangeCount === 0 || current.anchorNode === null,
          true,
        );
        if (empty) {
          const anchor = yield* dom.probeOr(
            () => findCaretAnchor(doc),
            Option.none<Text>(),
          );
          if (Option.isNone(anchor)) {
            yield* hud.show("No text on this page to select.");
            yield* exitCurrent();
            return;
          }
          const placed = yield* dom.probeOr(() => {
            current.setBaseAndExtent(anchor.value, 0, anchor.value, 0);
            return true;
          }, false);
          if (!placed) {
            yield* report.error("Could not place the caret on this page.");
            yield* exitCurrent();
            return;
          }
        }

        const viewport = yield* ui.viewport;
        yield* Effect.asVoid(dom.probeOr(() => {
          // Caret mode never inherits a range: `c` from visual mode collapses
          // onto the end that the user was steering.
          if (alterFor(kind) === "move") collapseToFocus(current);

          // `isCollapsed` is wrong when the selection lives wholly inside an
          // open shadow root: both boundaries retarget to the same host node.
          // The composed read is the only one that can tell the difference, and
          // `ShadowRoot.getSelection()`, which everybody reaches for first, is
          // not implemented in Safari at all.
          const boundaries = readBoundaries(current, capabilities);
          const collapsed = Option.isSome(boundaries)
            ? boundaries.value.collapsed
            : current.isCollapsed;

          // A collapsed selection draws nothing in a page that is not
          // editable, because there is no caret of the page to inherit. Caret
          // mode therefore draws one out of a selection of one character.
          if (collapsed) extendByOneCharacter(current);
          if (kind === "visual-line") extendToLines(current);
          scrollSelectionIntoView(current, viewport);
          return true;
        }, false));
      });

      // -- entering ------------------------------------------------------

      const enterKind = Effect.fn("Visual.enterKind")(
        function*(kind: VisualKind) {
          if (!capabilities.selectionModify) {
            // Every capability that is `false` gets an explanation that the
            // user can see. This one should be unreachable on any WebKit build
            // that this application targets.
            yield* report.error(
              "Selection.modify() is unavailable, so visual mode cannot run " +
                "here.",
            );
            return;
          }

          // The hand-over. The mode before this one keeps the selection.
          yield* release("singleton");
          yield* Ref.set(count, 0);
          yield* Ref.set(pendingG, false);

          const scope = yield* Scope.make();
          const handle = yield* Effect.provideService(
            modes.enter({
              name: kind,
              indicator: INDICATORS[kind],
              exitOnEscape: true,
              // These modes own the keyboard outright: a key that they do not
              // use must not reach the page, or `j` scrolls out from under the
              // selection.
              suppressAllKeyboardEvents: true,
              singleton: "visual",
            }, {
              keydown: onKeydown(kind),
            }),
            Scope.Scope,
            scope,
          );

          yield* handle.onExit((reason) =>
            // A `singleton` exit means that `v`, `V` or `c` is handing over to
            // a sibling. The selection is the state that is handed over, and it
            // must survive.
            reason === "singleton" ? Effect.void : clearSelection
          );

          yield* Ref.set(live, Option.some({ kind, scope, handle }));
          yield* start(kind);
        },
      );

      // The layer scope owns the live mode. Closing the runtime therefore ends
      // the mode and gives the selection back to the page.
      yield* Effect.addFinalizer(() => release("navigation"));

      const service = Visual.of({
        enterVisual: enterKind("visual"),
        enterVisualLine: enterKind("visual-line"),
        enterCaret: enterKind("caret"),
      });

      yield* commands.registerAll({
        enterVisualMode: () => service.enterVisual,
        enterVisualLineMode: () => service.enterVisualLine,
        enterCaretMode: () => service.enterCaret,
      });

      return service;
    }),
  );
}
