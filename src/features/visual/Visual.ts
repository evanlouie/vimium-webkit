/**
 * Visual mode, visual line mode and caret mode.
 *
 * Ported from the `content_scripts/mode_visual.js` of Vimium (MIT). The three
 * modes are one implementation, and they differ in two ways. `KindProfile`
 * holds the difference:
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

import {
  Boolean,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Predicate,
  Record,
  Ref,
  Schema,
  Scope,
  flow,
  pipe,
} from "effect";
import { constTrue, constVoid } from "effect/Function";
import { Commands } from "~/core/Commands.ts";
import { type HandlerResult, SUPPRESS_EVENT } from "~/core/HandlerStack.ts";
import { type ExitReason, ExitTrigger, KeyPolicy, type ModeHandle, Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { appendCountDigit, isComposing, isCountDigit, keyNotation } from "~/domain/Key.ts";
import { Capabilities, type CapabilityReport } from "~/platform/Capabilities.ts";
import { Clipboard } from "~/platform/Clipboard.ts";
import { Dom } from "~/platform/Dom.ts";
import { BRIEFLY, Hud, HudDuration } from "~/ui/Hud.ts";
import { Ui } from "~/ui/Ui.ts";
import {
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

/**
 * WebKit does not give a page the content of the clipboard outside its own
 * paste control, and a userscript cannot make a gesture that changes that. To
 * say so is better than a key that does nothing.
 */
const PASTE_EXPLANATION =
  "Paste is unavailable: WebKit only releases clipboard contents through its " +
  "own paste affordance. Use ⌘V (Ctrl+V).";

/** How long the explanation above stays on screen. */
const PASTE_EXPLANATION_DURATION: HudDuration = HudDuration.Transient({
  duration: Duration.millis(4000),
});

/** `1 character`, or `2 characters`. */
const characters = (count: number): string =>
  pipe(
    count === 1,
    Boolean.match({
      onTrue: () => "1 character",
      onFalse: () => `${count} characters`,
    }),
  );

/** A live mode, and the scope that owns it. */
interface LiveVisual {
  readonly kind: VisualKind;
  readonly scope: Scope.Closeable;
  readonly handle: ModeHandle;
}

// ---------------------------------------------------------------------------
// What sets the kinds apart
// ---------------------------------------------------------------------------

/**
 * Grow a collapsed selection to one character.
 *
 * A collapsed selection draws nothing in a page that is not editable, because
 * there is no caret of the page to inherit. Caret mode therefore draws one out
 * of a selection of one character.
 *
 * `isCollapsed` is wrong when the selection lives wholly inside an open shadow
 * root: both boundaries retarget to the same host node. The composed read is
 * the only one that can tell the difference, and `ShadowRoot.getSelection()`,
 * which everybody reaches for first, is not implemented in Safari at all.
 */
const showCaret = (current: Selection, capabilities: CapabilityReport): void =>
  pipe(
    readBoundaries(current, capabilities),
    Option.match({
      onNone: () => current.isCollapsed,
      onSome: (boundaries) => boundaries.collapsed,
    }),
    Boolean.match({
      onFalse: constVoid,
      onTrue: () => {
        extendByOneCharacter(current);
      },
    }),
  );

/** What one kind does differently: the table at the top of this file, as data. */
interface KindProfile {
  readonly indicator: string;
  /** Run one motion, `repeat` times. */
  readonly move: (target: Selection, spec: MovementSpec, repeat: number) => void;
  /** Shape the selection that the mode starts from. */
  readonly shape: (current: Selection, capabilities: CapabilityReport) => void;
}

const VISUAL: KindProfile = {
  indicator: "Visual",
  move: (target, spec, repeat) => runMovement(target, "extend", spec, repeat),
  shape: showCaret,
};

const VISUAL_LINE: KindProfile = {
  indicator: "Visual line",
  move: (target, spec, repeat) => {
    runMovement(target, "extend", spec, repeat);
    extendToLines(target);
  },
  shape: (current, capabilities) => {
    showCaret(current, capabilities);
    extendToLines(current);
  },
};

const CARET: KindProfile = {
  indicator: "Caret",
  // Fold the display selection of one character away first, so that the move
  // starts at the caret and not at its far end.
  move: (target, spec, repeat) => {
    collapseToAnchor(target);
    runMovement(target, "move", spec, repeat);
    extendByOneCharacter(target);
  },
  // Caret mode never inherits a range: `c` from visual mode collapses onto the
  // end that the user was steering.
  shape: (current, capabilities) => {
    collapseToFocus(current);
    showCaret(current, capabilities);
  },
};

const profileOf: (kind: VisualKind) => KindProfile = pipe(
  Match.type<VisualKind>(),
  Match.when("visual", () => VISUAL),
  Match.when("visual-line", () => VISUAL_LINE),
  Match.when("caret", () => CARET),
  Match.exhaustive,
);

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** What the keys typed so far mean to the next key. */
type Typed = Data.TaggedEnum<{
  /** `count` is the count prefix. It is `0` when none is typed. */
  Plain: { readonly count: number };
  /** `g` was pressed, and the next key completes the sequence. */
  AfterG: { readonly count: number };
}>;

const Typed = Data.taggedEnum<Typed>();

const NOTHING_TYPED: Typed = Typed.Plain({ count: 0 });

/** What one key asks the mode to do. */
type KeyCommand = Data.TaggedEnum<{
  Motion: { readonly spec: MovementSpec; readonly repeat: number };
  Yank: Record.ReadonlyRecord<never, never>;
  SwapEnds: Record.ReadonlyRecord<never, never>;
  Enter: { readonly kind: VisualKind };
  ExplainPaste: Record.ReadonlyRecord<never, never>;
}>;

const KeyCommand = Data.taggedEnum<KeyCommand>();

/** The keys of these modes that are not motions. */
const KEY_COMMANDS: Record.ReadonlyRecord<string, KeyCommand> = {
  y: KeyCommand.Yank(),
  o: KeyCommand.SwapEnds(),
  c: KeyCommand.Enter({ kind: "caret" }),
  v: KeyCommand.Enter({ kind: "visual" }),
  V: KeyCommand.Enter({ kind: "visual-line" }),
  p: KeyCommand.ExplainPaste(),
  P: KeyCommand.ExplainPaste(),
};

/** The state after one key, and what the key asks for. */
interface KeyTransition {
  readonly next: Typed;
  readonly commands: ReadonlyArray<KeyCommand>;
}

const typing = (next: Typed): KeyTransition => ({ next, commands: [] });

/** A key that acts, or that means nothing, drops the count. */
const acting = (commands: ReadonlyArray<KeyCommand>): KeyTransition => ({
  next: NOTHING_TYPED,
  commands,
});

/** A motion runs `count` times, and once when no count is typed. */
const motion =
  (count: number) =>
  (spec: MovementSpec): KeyCommand =>
    KeyCommand.Motion({ spec, repeat: Math.max(1, count) });

/** The meaning of `notation` when no `g` is pending. */
const pressPlain = (notation: string, count: number): KeyTransition =>
  pipe(
    Match.value(notation),
    // The rule of Vim: `0` is a motion, except while a count is being typed.
    // The count has a limit, because these modes suppress every keyboard
    // event, so an unlimited `999999999j` was a freeze that Escape could not
    // end.
    Match.when(
      (key) => isCountDigit(key, count > 0),
      (key) => typing(Typed.Plain({ count: appendCountDigit(count, key) })),
    ),
    Match.when("g", () => typing(Typed.AfterG({ count }))),
    Match.orElse((key) => pipe(commandFor(key, count), Option.toArray, acting)),
  );

/** What any other key asks for: a motion, another command, or nothing. */
const commandFor = (key: string, count: number): Option.Option<KeyCommand> =>
  pipe(
    MOVEMENTS,
    Record.get(key),
    Option.map(motion(count)),
    Option.orElse(() => pipe(KEY_COMMANDS, Record.get(key))),
  );

/** `gg`, which is the one motion of two keys. */
const secondG = (count: number): KeyTransition =>
  pipe(MOVEMENTS, Record.get("gg"), Option.map(motion(count)), Option.toArray, acting);

/** The meaning of one key, after the keys typed before it. */
const pressKey = (notation: string): ((typed: Typed) => KeyTransition) =>
  Typed.$match({
    AfterG: ({ count }) =>
      pipe(
        notation === "g",
        Boolean.match({
          onTrue: () => secondG(count),
          // `gj` is not a binding, but `g` and then a true motion must still
          // run that motion instead of being swallowed.
          onFalse: () => pressPlain(notation, count),
        }),
      ),
    Plain: ({ count }) => pressPlain(notation, count),
  });

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/** Why a mode could not establish the selection that it starts from. */
class VisualStartError extends Schema.TaggedError<VisualStartError>()("VisualStartError", {
  reason: Schema.Literals(["unavailable", "no-text", "unplaceable"]),
}) {}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/** The three modes, as the bodies of the commands that enter them. */
export const VisualLayer: Layer.Layer<
  never,
  never,
  Dom | Ui | Hud | Settings | Modes | Commands | Report | Capabilities | Clipboard
> = Layer.effectDiscard(
  Effect.gen(function* () {
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
    /** The count prefix, and whether a `g` is pending. */
    const typed = yield* Ref.make<Typed>(NOTHING_TYPED);

    const selection: Effect.Effect<Option.Option<Selection>> = dom.probeOrElse(
      () => Option.fromNullishOr(win.getSelection()),
      Option.none,
    );

    /** Read or change the selection inside `dom.probeOrElse`. No selection gives `fallback`. */
    const probeSelection = <A>(read: (selection: Selection) => A, fallback: A): Effect.Effect<A> =>
      pipe(
        selection,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(fallback),
            onSome: (target) =>
              dom.probeOrElse(
                () => read(target),
                () => fallback,
              ),
          }),
        ),
      );

    /** Run one synchronous piece of selection work, and ignore a refusal. */
    const withSelection = (body: (selection: Selection) => void): Effect.Effect<void> =>
      probeSelection(body, undefined);

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
    const release = Effect.fn("Visual.release")(function* (reason: ExitReason) {
      const entry = yield* pipe(live, Ref.getAndSet(Option.none<LiveVisual>()));
      yield* pipe(
        entry,
        Option.match({
          onNone: () => Effect.void,
          // The exit comes first, and with the true reason. Closing the
          // scope alone would exit the mode with `"navigation"`, and the
          // hand-over would then throw the selection away.
          onSome: ({ handle, scope }) =>
            pipe(handle.exit(reason), Effect.andThen(Scope.close(scope, Exit.void))),
        }),
      );
    });

    /** End the live mode from inside one of its own key handlers. */
    const exitCurrent = Effect.fn("Visual.exitCurrent")(function* () {
      const entry = yield* Ref.get(live);
      yield* pipe(
        entry,
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ handle }) => handle.exit("explicit"),
        }),
      );
    });

    // -- motions -------------------------------------------------------

    const runMotion = Effect.fn("Visual.runMotion")(function* (
      kind: VisualKind,
      spec: MovementSpec,
      repeat: number,
    ) {
      const viewport = yield* ui.viewport;
      yield* withSelection((target) => {
        profileOf(kind).move(target, spec, repeat);
        scrollSelectionIntoView(doc, target, viewport);
      });
    });

    const swapEnds = Effect.fn("Visual.swapEnds")(function* () {
      const viewport = yield* ui.viewport;
      yield* withSelection((target) => {
        reverseSelection(target);
        scrollSelectionIntoView(doc, target, viewport);
      });
    });

    // -- yank ----------------------------------------------------------

    /**
     * Start the write of `text`, and say so.
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
    const copy = (text: string): Effect.Effect<void> =>
      pipe(
        clipboard.write(text),
        Effect.catch((error) => report.error(`Copy failed: ${error.detail}`)),
        Effect.forkDetach({ startImmediately: true }),
        Effect.andThen(hud.show(`Yanked ${characters(text.length)}`, BRIEFLY)),
      );

    /** `y`: copy the selection and leave. */
    const yank = Effect.fn("Visual.yank")(function* () {
      const text = yield* probeSelection(selectionText, "");
      yield* pipe(
        text,
        Option.liftPredicate((text) => text.length > 0),
        Option.match({
          onNone: () => hud.show("Nothing to copy", BRIEFLY),
          onSome: copy,
        }),
      );
      yield* exitCurrent();
    });

    // -- keys ----------------------------------------------------------

    const runCommand = (kind: VisualKind): ((command: KeyCommand) => Effect.Effect<void>) =>
      KeyCommand.$match({
        Motion: ({ spec, repeat }) => runMotion(kind, spec, repeat),
        Yank: () => yank(),
        SwapEnds: () => swapEnds(),
        Enter: (command) => enterKind(command.kind),
        ExplainPaste: () => hud.show(PASTE_EXPLANATION, PASTE_EXPLANATION_DURATION),
      });

    const handleKey = Effect.fn("Visual.handleKey")(function* (kind: VisualKind, notation: string) {
      const commands = yield* pipe(
        typed,
        Ref.modify(flow(pressKey(notation), ({ next, commands }) => [commands, next] as const)),
      );
      yield* pipe(commands, Effect.forEach(runCommand(kind), { discard: true }));
    });

    const onKeydown =
      (kind: VisualKind) =>
      (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
        pipe(
          event,
          // A keystroke in the middle of a composition belongs to the input
          // method, and not to us.
          Option.liftPredicate(Predicate.not(isComposing)),
          Option.flatMap((event) =>
            keyNotation(event, {
              ignoreKeyboardLayout: settings.currentUnsafe().ignoreKeyboardLayout,
              applePlatform: capabilities.applePlatform,
            }),
          ),
          Option.match({
            onNone: () => Effect.void,
            onSome: (notation) => handleKey(kind, notation),
          }),
          Effect.as(SUPPRESS_EVENT),
        );

    // -- the first selection -------------------------------------------

    /** The selection of this frame, when `Selection.modify` works on it. */
    const modifiableSelection: Effect.Effect<Selection, VisualStartError> = pipe(
      probeSelection(Option.liftPredicate(canModify), Option.none<Selection>()),
      Effect.flatMap(Effect.fromOption(() => new VisualStartError({ reason: "unavailable" }))),
    );

    /** Put a caret at the start of the first large text of the page. */
    const placeCaret = (current: Selection): Effect.Effect<void, VisualStartError> =>
      pipe(
        dom.probeOrElse(() => findCaretAnchor(doc), Option.none),
        Effect.flatMap(Effect.fromOption(() => new VisualStartError({ reason: "no-text" }))),
        Effect.flatMap((anchor) =>
          pipe(
            dom.attempt("Selection.setBaseAndExtent", () =>
              current.setBaseAndExtent(anchor, 0, anchor, 0),
            ),
            Effect.mapError(() => new VisualStartError({ reason: "unplaceable" })),
          ),
        ),
      );

    /**
     * A selection that is already there is adopted, and not replaced. That
     * is what makes `v` after a find, or after a drag with the mouse, do the
     * obvious thing. An empty one gets a caret.
     */
    const adoptOrPlace = (current: Selection): Effect.Effect<Selection, VisualStartError> =>
      pipe(
        dom.probeOrElse(() => current.rangeCount === 0 || current.anchorNode === null, constTrue),
        Effect.flatMap(
          Boolean.match({
            onFalse: () => Effect.void,
            onTrue: () => placeCaret(current),
          }),
        ),
        Effect.as(current),
      );

    const explainRefusal = ({ reason }: VisualStartError): Effect.Effect<void> =>
      pipe(
        Match.value(reason),
        Match.when("unavailable", () =>
          report.error("Text selection is not available in this frame."),
        ),
        Match.when("no-text", () => hud.show("No text on this page to select.", BRIEFLY)),
        Match.when("unplaceable", () => report.error("Could not place the caret on this page.")),
        Match.exhaustive,
      );

    /** Establish the selection that the mode starts from. */
    const start = Effect.fn("Visual.start")(
      function* (kind: VisualKind) {
        const current = yield* pipe(modifiableSelection, Effect.flatMap(adoptOrPlace));
        const viewport = yield* ui.viewport;
        yield* dom.probeOrElse(() => {
          profileOf(kind).shape(current, capabilities);
          scrollSelectionIntoView(doc, current, viewport);
        }, constVoid);
      },
      Effect.catchTag("VisualStartError", (error) =>
        pipe(explainRefusal(error), Effect.andThen(exitCurrent())),
      ),
    );

    // -- entering ------------------------------------------------------

    /**
     * A `singleton` exit means that `v`, `V` or `c` is handing over to a
     * sibling. The selection is the state that is handed over, and it must
     * survive.
     */
    const afterExit = (reason: ExitReason): Effect.Effect<void> =>
      pipe(
        Match.value(reason),
        Match.when("singleton", () => Effect.void),
        Match.orElse(() => clearSelection),
      );

    const openMode = Effect.fn("Visual.openMode")(function* (kind: VisualKind) {
      // The hand-over. The mode before this one keeps the selection.
      yield* release("singleton");
      yield* pipe(typed, Ref.set<Typed>(NOTHING_TYPED));

      const scope = yield* Scope.make();
      const handle = yield* pipe(
        modes.enter(
          {
            name: kind,
            indicator: Option.some(profileOf(kind).indicator),
            exitOn: [ExitTrigger.Escape()],
            // These modes own the keyboard outright: a key that they do not
            // use must not reach the page, or `j` scrolls out from under the
            // selection.
            keyboard: KeyPolicy.Owned(),
            singleton: Option.some("visual"),
          },
          {
            keydown: onKeydown(kind),
          },
        ),
        Scope.provide(scope),
      );

      yield* handle.onExit(afterExit);
      yield* pipe(live, Ref.set(Option.some({ kind, scope, handle })));
      yield* start(kind);
    });

    const enterKind = Effect.fn("Visual.enterKind")(function* (kind: VisualKind) {
      yield* pipe(
        capabilities.selectionModify,
        Boolean.match({
          // Every capability that is `false` gets an explanation that the
          // user can see. This one should be unreachable on any WebKit build
          // that this application targets.
          onFalse: () =>
            report.error("Selection.modify() is unavailable, so visual mode cannot run here."),
          onTrue: () => openMode(kind),
        }),
      );
    });

    // The layer scope owns the live mode. Closing the runtime therefore ends
    // the mode and gives the selection back to the page.
    yield* Effect.addFinalizer(() => release("navigation"));

    yield* commands.registerAll({
      enterVisualMode: () => enterKind("visual"),
      enterVisualLineMode: () => enterKind("visual-line"),
      enterCaretMode: () => enterKind("caret"),
    });
  }),
);
