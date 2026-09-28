/**
 * Link hints: the round, the mode and the activation.
 *
 * Ported from the Vimium `content_scripts/link_hints.js` (`LinkHintsMode`,
 * `AlphabetHints`, `FilterHints`, `simulateClick`), MIT, and from the hint half
 * of the old frame coordinator.
 *
 * The parts that belong to WebKit are all in activation. Two of them matter
 * enough to state here:
 *
 * - **A synthetic Command-click or Control-click does not open a new tab.** An
 *   untrusted event never reaches the activation path of the browser, so the
 *   modifier is ignored and the click happens in this tab. That is a wrong
 *   action with no message, which is the worst kind. A new-tab mode therefore
 *   reads the `href` and goes through `Tabs.open`.
 * - **A clipboard write must be reached synchronously from the key task.**
 *   Nothing on the path to `Clipboard.write` may suspend, or the transient
 *   activation of Safari is already spent. Activation runs in a fiber that
 *   `Effect.forkDetach` starts at once, so it runs on the key stack until it
 *   suspends, and the manager write happens before that point.
 *
 * ## The round
 *
 * `src/frames/Link.ts` deliberately does not answer the hint messages. This
 * service answers them, with `FrameBus.serve`, and that is the seam that keeps
 * the layer graph a tree. The four rules that `src/domain/FrameMessage.ts`
 * states are kept here:
 *
 * 1. **One live round for the page, with an age limit.** The top frame holds
 *    the record. A second frame cannot start a round while one is live, and a
 *    round older than `ROUND_TTL_MS` is not live any more. The frame that owns
 *    the live round may replace it, because a frame that asks again has
 *    abandoned what it had.
 * 2. **Only the owner of the round may drive it, and only once.** Each frame
 *    holds its own record of the round that it answered. It acts on an
 *    `ACTIVATE_HINT` only when the sender is the origin that the `ACTIVATE`
 *    named, when the mode is the mode of the round, and when the round is still
 *    inside its age limit. The record is then cleared, so one authorised
 *    request cannot be replayed into a click on every element that the frame
 *    ever hinted.
 * 3. **A keystroke counts only inside a round.** A `KEYSTROKE` is used only by
 *    a frame that holds a live participant session, and only when the sender is
 *    the frame that drives that session.
 * 4. **A frame speaks for its own descriptors only.** A descriptor whose
 *    `frameId` is not the frame that sent it is dropped, and an element
 *    reference never leaves the frame that owns it. Only the four fields of
 *    `HintDescriptor` travel.
 * 5. **A timeout ends the named round everywhere.** The origin broadcasts
 *    `CANCEL_HINTS`. Each matching frame removes its round and session.
 */

import {
  Array,
  Boolean,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  FiberHandle,
  flow,
  identity,
  Layer,
  Match,
  Option,
  pipe,
  Predicate,
  Record,
  Ref,
  Result,
  Schema,
  String,
  Struct,
} from "effect";
import { constFalse, constVoid } from "effect/Function";
import { Commands } from "~/core/Commands.ts";
import { type HandlerResult, SUPPRESS_EVENT } from "~/core/HandlerStack.ts";
import { type ExitReason, ExitTrigger, KeyPolicy, type ModeHandle, Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings, type SettingsData } from "~/core/Settings.ts";
import {
  type FrameMessage,
  type HintDescriptor,
  type HintMode,
  limitDescriptors,
  MAX_FRAME_DESCRIPTORS,
  type MessageOf,
  REQUEST_DEADLINE_MS,
} from "~/domain/FrameMessage.ts";
import {
  type FilterCandidate,
  filterHints,
  type FilterMatch,
  type FilterOutcome,
  matchedPrefixLength,
} from "~/domain/HintFilter.ts";
import { hintStrings, matchByPrefix, normaliseHintCharacters } from "~/domain/HintString.ts";
import { isComposing, type KeyContext, keyNotation } from "~/domain/Key.ts";
import {
  FrameBus,
  type InboundMessage,
  type InboundOf,
  REQUEST_DEADLINE,
  toFrame,
  toTop,
} from "~/frames/Bus.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Clipboard } from "~/platform/Clipboard.ts";
import { Dom } from "~/platform/Dom.ts";
import { type FrameId, FrameRole } from "~/platform/Realm.ts";
import { OpenInTabResult, Tabs } from "~/platform/Tabs.ts";
import { BRIEFLY, Hud, HudDuration } from "~/ui/Hud.ts";
import { Ui } from "~/ui/Ui.ts";
import { detectHints, type HintRect, HintTargets, isSecondary, type LocalHint } from "./Detect.ts";
import { hintCss, makeMarkerLayer, MarkerSpec } from "./Markers.ts";

export type { LocalHint } from "./Detect.ts";
export { HINT_CSS, hintCss, isSafeUserCss } from "./Markers.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long the whole collection may take.
 *
 * It is longer than the deadline of one frame on purpose. With the same value,
 * one frame that never answers costs the descriptors of *every* frame, because
 * the outer wait ends at the same moment as the inner one. A frame that hangs
 * must cost its own hints, and no more.
 */
export const COLLECT_DEADLINE_MS = REQUEST_DEADLINE_MS + 500;

/**
 * How long a round keeps authorising a remote activation.
 *
 * It is the same value in every frame. Filter mode with
 * `waitForEnterForFilteredHints` can keep a session open while the user reads
 * the page, so this bounds a capability, and it is not a limit on an
 * interaction.
 */
const ROUND_TTL_MS = 120_000;

/** How long a pause in the typing counts as confirmation of one match. */
export const FILTER_CONFIRM_DELAY_MS = 200;

/** Give the keyboard back after this long, and do not eat the keys of the user. */
export const KEY_BUFFER_SAFETY_MS = COLLECT_DEADLINE_MS + 500;

/** The alphabet that is used when the setting cannot give a usable one. */
const DEFAULT_HINT_CHARACTERS = "sadfjklewcmpgh";

/** The digits that are used when the setting cannot give a usable set. */
const DEFAULT_HINT_NUMBERS = "0123456789";

/** The ceiling on the link text of a descriptor. It is the bound of the wire. */
const MAX_WIRE_LINK_TEXT = 256;

/** How many ended rounds a frame remembers, so that a late message for one is dropped. */
const CANCELLED_ROUNDS_KEPT = 32;

/** The events that lift a pointer off an element that it only hovered. */
const RELEASE_HOVER = ["pointerout", "mouseout"] as const;

/** The events that end a press, and then the hover. */
const RELEASE_PRESS = ["pointerup", "mouseup", "pointerout", "mouseout"] as const;

/** Some events of a synthetic click, and what undoes them when the next check fails. */
interface ClickStage {
  readonly send: readonly string[];
  readonly undo: readonly string[];
}

/**
 * The full sequence of events that a true click produces, before the `click`.
 *
 * A partial sequence is the reason that "the hint did nothing" reports exist.
 * The synthetic-event bridge of React listens for `pointerdown`, an older
 * widget listens for `mousedown`, and a menu that follows the pointer opens on
 * `mouseover` only.
 *
 * The target is checked after each stage, because page event handlers run
 * between the events and can change it. A failed check sends the `undo` of its
 * stage, which balances a press that started.
 */
const CLICK_STAGES: readonly ClickStage[] = [
  { send: ["pointerover", "mouseover"], undo: RELEASE_HOVER },
  { send: ["pointerdown"], undo: RELEASE_PRESS },
  { send: ["mousedown"], undo: RELEASE_PRESS },
  { send: ["pointerup", "mouseup"], undo: RELEASE_HOVER },
];

/** The events of a hover. A menu that follows the pointer opens on `mouseover` only. */
const HOVER_SEQUENCE = ["pointerover", "mouseover"] as const;

/** The elements that take the focus before a click, because their handlers read it. */
const FOCUS_BEFORE_CLICK = ["input", "select", "object", "embed"];

const INDICATORS: Record.ReadonlyRecord<HintMode, string> = {
  activate: "Hints",
  "activate-new-tab": "Hints: new tab",
  "activate-new-tab-background": "Hints: background tab",
  hover: "Hints: hover",
  focus: "Hints: focus",
  "copy-link-url": "Hints: copy URL",
  "copy-link-text": "Hints: copy text",
  "open-with-omnibar": "Hints: omnibar",
  download: "Hints: download",
};

/** The modes that write the clipboard, and that therefore need a true gesture. */
const writesClipboard = (mode: HintMode): boolean =>
  mode === "copy-link-url" || mode === "copy-link-text";

/** What a mode can act on. A mode that acts on a URL hints only what truly has one. */
const targetsFor = (mode: HintMode): HintTargets =>
  pipe(
    Match.value(mode),
    Match.withReturnType<HintTargets>(),
    Match.whenOr("activate", "hover", "focus", "copy-link-text", () => HintTargets.Clickable()),
    Match.whenOr(
      "activate-new-tab",
      "activate-new-tab-background",
      "copy-link-url",
      "open-with-omnibar",
      "download",
      () => HintTargets.Linked(),
    ),
    Match.exhaustive,
  );

/** What the user reads when a check refuses a hint. */
const MOVED_DETAIL = "The page moved that hint. Nothing was activated.";

const HINTS_STOPPED = "Hints stopped: the page did not answer in time.";

const DOWNLOAD_DETAIL =
  "Download-link hints are not possible in a userscript on " +
  "WebKit. A synthetic Alt-click cannot start a download. " +
  "Use Control-click, then select Download Linked File.";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A variant with no data of its own. */
type NoFields = Record.ReadonlyRecord<never, never>;

/** Run `f` on a value that is present. Absence does nothing. */
const whenSome = <A>(
  f: (value: A) => Effect.Effect<void>,
): ((option: Option.Option<A>) => Effect.Effect<void>) =>
  Option.match({ onNone: () => Effect.void, onSome: f });

/** Run `effect` when a mode exited on Escape, and nothing for any other reason. */
const whenEscaped =
  (effect: Effect.Effect<void>) =>
  (reason: ExitReason): Effect.Effect<void> =>
    pipe(
      Match.value(reason),
      Match.when("escape", () => effect),
      Match.orElse(() => Effect.void),
    );

/** Complete a signal that carries no value. */
const signal: (deferred: Deferred.Deferred<void>) => Effect.Effect<void> = flow(
  Deferred.succeed<void>(undefined),
  Effect.asVoid,
);

/** How a key notation reads under the settings of this frame. */
const keyContextFor = (settings: SettingsData, applePlatform: boolean): KeyContext => ({
  ignoreKeyboardLayout: settings.ignoreKeyboardLayout,
  applePlatform,
});

/**
 * One hint of the globally ordered list of the session.
 *
 * `hint` is present for a hint of this frame only. Every frame holds the same
 * list in the same order, and only the owner can draw or activate.
 */
export interface HintEntry {
  readonly frameId: FrameId;
  readonly localIndex: number;
  readonly linkText: string;
  readonly secondary: boolean;
  readonly hint: Option.Option<LocalHint>;
}

/** What this frame tells the other frames about its own hints. */
const descriptorsFor = (frameId: FrameId, hints: readonly LocalHint[]): readonly HintDescriptor[] =>
  pipe(
    hints,
    Array.take(MAX_FRAME_DESCRIPTORS),
    Array.map((hint, localIndex) => ({
      frameId,
      localIndex,
      // Cut to the bound of the wire. A longer value makes the whole message
      // fail the schema of the receiver, and that frame would lose every hint.
      linkText: hint.linkText.slice(0, MAX_WIRE_LINK_TEXT),
      secondary: isSecondary(hint),
    })),
  );

/**
 * One entry of the merged list.
 *
 * The bus already checked that a frame speaks for itself, and the wire schema
 * decoded the id of the frame.
 */
const entryFor =
  (self: FrameId, local: readonly LocalHint[]) =>
  (descriptor: HintDescriptor): HintEntry => ({
    frameId: descriptor.frameId,
    localIndex: descriptor.localIndex,
    linkText: descriptor.linkText,
    secondary: descriptor.secondary,
    hint: pipe(
      descriptor,
      Option.liftPredicate((own) => own.frameId === self),
      Option.flatMap((own) => pipe(local, Array.get(own.localIndex))),
    ),
  });

/** The button fields of one mouse event or one pointer event. */
export interface ButtonState {
  /** Which button changed. It is `-1` when no button changed. */
  readonly button: number;
  /** Which buttons are down. It is a bit field, and `1` is the primary button. */
  readonly buttons: number;
}

const PRIMARY_DOWN: ButtonState = { button: 0, buttons: 1 };
const PRIMARY_UP: ButtonState = { button: 0, buttons: 0 };
const NO_BUTTON_CHANGE: ButtonState = { button: -1, buttons: 0 };

/**
 * The button fields that a true mouse gives to one event of a click.
 *
 * The primary button is down for `pointerdown` and for `mousedown` only. It is
 * up again before `pointerup`, `mouseup` and `click`, so those three carry
 * `buttons: 0`. A control that reads `buttons` to find out whether a drag is in
 * progress refuses a click that says that the button is still down. A control
 * that tracks the press stays in the pressed state after such a click.
 *
 * A pointer event that reports no change of a button carries `button: -1`. The
 * specification gives that value to `pointerover`, `pointerout` and
 * `pointermove`. The mouse events of the same names carry `button: 0`.
 */
export const buttonStateFor = (type: string): ButtonState =>
  pipe(
    Match.value(type),
    Match.whenOr("pointerdown", "mousedown", () => PRIMARY_DOWN),
    Match.whenOr("pointerup", "mouseup", "click", () => PRIMARY_UP),
    Match.when(String.startsWith("pointer"), () => NO_BUTTON_CHANGE),
    Match.orElse(() => PRIMARY_UP),
  );

/** Where an activation came from. A remote one has no gesture of the user. */
export type ActivationOrigin = "local" | "remote";

/** Collect and bound the descriptors that the coordinator received. */
export const collectFrameDescriptors = Effect.fn("Hints.collectFrameDescriptors")(function* (
  peers: readonly FrameId[],
  request: (frameId: FrameId) => Effect.Effect<readonly HintDescriptor[]>,
) {
  const replies = yield* pipe(peers, Effect.forEach(request, { concurrency: "unbounded" }));
  const all = Array.flatten(replies);
  const descriptors = limitDescriptors(all);
  return { descriptors, dropped: all.length - descriptors.length };
});

// ---------------------------------------------------------------------------
// Revalidation
// ---------------------------------------------------------------------------

/**
 * The marker says one element, and the click must land on that element.
 *
 * A marker is drawn for the element that detection found. The user then reads
 * the page and presses a key. Between those two moments a container can scroll,
 * the page can reflow, and the page can take the element away. A click that
 * lands on another element is the defect, and it is a security defect, because
 * the page chooses what stands under the marker at that moment.
 *
 * The four decisions are these.
 *
 * **When we check.** At two moments, and for two different reasons.
 *
 * - On every scroll and on every resize, the session measures the target of
 *   each of its own hints again, and it draws the markers where the targets
 *   are now. One pass for each animation frame. This is the moment that keeps
 *   the marker on its element while the user reads.
 * - At the key press, the owning frame checks before every mode.
 * - Click mode checks again before `mousedown` and before `click`. Page event
 *   handlers run between these checks and can change the target.
 *
 * **What we compare.** Three things, because an identity alone proves nothing.
 * The page can move an element, and it can put another element on top of it.
 *
 * 1. The element and its hit target are still in the document.
 * 2. The target has not moved. `anchor` is where the target stood at the
 *    detection pass, and `shift` is how far the last draw moved the marker
 *    with it. A difference of more than `MAX_HINT_DRIFT_PX` between the two is
 *    a layout that the user did not see.
 * 3. The point at the centre of the drawn marker still hits the target. The
 *    walk of the hit stack is the walk of the detection pass: our own overlay
 *    is skipped, the target and anything inside it are accepted, a host of the
 *    target is accepted, and the first other element refuses the hint.
 *
 * **What happens when the check fails.** Nothing is clicked, nothing is
 * copied, and the user reads one line in the HUD. We do not activate a
 * neighbour, and we do not guess. We also do not start a new round, because a
 * round that starts by itself takes the keyboard back from a user who has
 * moved on. The user presses the hint key again.
 *
 * **A hint of another frame.** A descriptor carries no geometry, and the
 * position that it would carry belongs to the viewport of its own frame. The
 * origin frame therefore never validates a remote hint. It sends
 * `ACTIVATE_HINT`, and the frame that owns the element runs exactly the same
 * check in its own document before it acts. A refusal returns to the origin
 * frame, which shows the message after its hint mode closes.
 */

/**
 * How far a hint target may move between the last draw and the key press.
 *
 * A fraction of a pixel comes from a scroll that ends between two animation
 * frames. More than a few pixels is a different layout.
 */
export const MAX_HINT_DRIFT_PX = 4;

/** How far a marker has moved with its target since the detection pass. */
export interface HintShift {
  readonly dx: number;
  readonly dy: number;
}

const NO_SHIFT: HintShift = { dx: 0, dy: 0 };

/** What the last draw of one local marker knew about its target. */
type Placement = Data.TaggedEnum<{
  /** The target is in the document, and the marker moved with it by `shift`. */
  Placed: { readonly shift: HintShift };
  /** The page took the element out of the document. */
  Gone: NoFields;
}>;

const Placement = Data.taggedEnum<Placement>();

/** A hint that nothing has moved yet. */
const AT_REST: Placement = Placement.Placed({ shift: NO_SHIFT });

/** No draw has measured a target yet. Every hint is at rest. */
const NO_PLACEMENTS: readonly Placement[] = [];

/** How far the last draw moved the marker of a local hint. `None` when its target is gone. */
const shiftAt = (placements: readonly Placement[], localIndex: number): Option.Option<HintShift> =>
  pipe(
    placements,
    Array.get(localIndex),
    Option.getOrElse(() => AT_REST),
    Placement.$match({
      Placed: ({ shift }) => Option.some(shift),
      Gone: () => Option.none(),
    }),
  );

/** Move a rect by the shift of its target. */
export const shiftedRect = (rect: HintRect, shift: HintShift): HintRect => ({
  left: rect.left + shift.dx,
  top: rect.top + shift.dy,
  width: rect.width,
  height: rect.height,
});

/**
 * Has the target moved away from the marker that the user saw?
 *
 * `anchor` is where the target stood at the detection pass. `shift` is the
 * movement that the last draw already applied to the marker. What is left is
 * movement that no draw followed, and the user aimed at the old place.
 */
export const hintHasMoved = (
  anchor: HintRect,
  current: HintRect,
  shift: HintShift,
  tolerance: number = MAX_HINT_DRIFT_PX,
): boolean =>
  Math.abs(current.left - anchor.left - shift.dx) > tolerance ||
  Math.abs(current.top - anchor.top - shift.dy) > tolerance;

/**
 * Does the front-to-back hit stack of one point belong to our hint?
 *
 * Our own overlay is skipped, because it is drawn over the whole viewport and
 * takes no pointer event. The first element after it decides: it is ours, or
 * the page painted something else at that point and the hint is refused.
 *
 * The walk is generic, so that it can be tested without a document.
 */
export const hitAccepts = <T>(
  stack: readonly T[],
  isOverlay: (candidate: T) => boolean,
  isOurs: (candidate: T) => boolean,
): boolean => pipe(stack, Array.findFirst(Predicate.not(isOverlay)), Option.exists(isOurs));

/**
 * Give the keyboard back after the safety time, and end the round.
 *
 * The collection is time-boxed. A page whose keyboard is dead because one
 * frame hangs is worse than a few keystrokes that are dropped, so `release`
 * gives the keyboard back at that moment.
 *
 * The round ends at that moment as well. The origin broadcasts its round ID.
 * Every participant then removes its markers, listener and session fiber.
 */
export const abortAfterSafety = (
  abort: Deferred.Deferred<void>,
  release: Effect.Effect<void>,
  delayMs: number = KEY_BUFFER_SAFETY_MS,
): Effect.Effect<void> =>
  pipe(Effect.sleep(delayMs), Effect.andThen(release), Effect.andThen(signal(abort)));

/**
 * Collect the hints, until the round is aborted.
 *
 * The loser of the race is interrupted. An abort therefore stops the detection
 * at its next slice, and it drops the answers of the other frames.
 */
export const raceUntilAbort = <A>(
  collect: Effect.Effect<Option.Option<A>>,
  abort: Deferred.Deferred<void>,
): Effect.Effect<Option.Option<A>> => {
  const aborted = pipe(abort, Deferred.await, Effect.as(Option.none<A>()));
  return pipe(collect, Effect.race(aborted));
};

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const rectOf = (element: Element): HintRect => {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
};

const centreOf = (element: Element): { x: number; y: number } => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

/**
 * The element that carries the geometry of a hint.
 *
 * An `<area>` of an image map has no layout box of its own, so the image
 * carries its geometry. `Detect.ts` puts the image in `hitTarget` for exactly
 * that reason.
 */
const targetOf = (hint: LocalHint): Element =>
  pipe(
    hint.hitTarget,
    Option.getOrElse(() => hint.element),
  );

/** Are the element of a hint and its hit target still in the document? */
const isAttached = (hint: LocalHint): boolean =>
  hint.element.isConnected && targetOf(hint).isConnected;

const isShadowRoot = (node: Node): node is ShadowRoot => node instanceof ShadowRoot;

/** The host of the shadow root that holds `node`, when a shadow root holds it. */
const shadowHostOf = (node: Node): Option.Option<Element> =>
  pipe(
    node.getRootNode(),
    Option.liftPredicate(isShadowRoot),
    Option.map((root) => root.host),
  );

/**
 * Does `ancestor` hold `node`, across an open shadow boundary?
 *
 * `Node.contains` stops at a shadow root, so a hit inside the own open shadow
 * root of the element would look like an unrelated element that is painted on
 * top. `Detect.ts` holds the same walk for the detection pass, and the two stay
 * apart on purpose: one decides what takes a hint, and this one decides what a
 * key press may click.
 */
const containsDeep = (ancestor: Element, node: Node): boolean =>
  ancestor.contains(node) ||
  pipe(
    shadowHostOf(node),
    Option.exists((host) => containsDeep(ancestor, host)),
  );

/** Every shadow host above `node`, nearest first. */
const shadowHostChain = (node: Node): readonly Element[] =>
  pipe(
    shadowHostOf(node),
    Option.match({
      onNone: () => Array.empty<Element>(),
      onSome: (host) => pipe(shadowHostChain(host), Array.prepend(host)),
    }),
  );

/** Is this a hit on the target, on something inside it, or on a host of it? */
const isOurTarget =
  (target: Element) =>
  (candidate: Element): boolean =>
    candidate === target ||
    containsDeep(target, candidate) ||
    pipe(
      shadowHostChain(target),
      Array.some((host) => host === candidate),
    );

const isEmptyRect = (rect: HintRect): boolean => rect.width <= 0 || rect.height <= 0;

/**
 * Is the target where the user saw it, and does the drawn marker still hit it?
 *
 * The checks run in order and stop at the first failure, because each one
 * reads more of the layout than the one before it.
 */
const targetStillMatches = (
  document: Document,
  overlayHost: Element,
  hint: LocalHint,
  anchor: HintRect,
  shift: HintShift,
): boolean => {
  const target = targetOf(hint);
  const drawn = shiftedRect(hint.rect, shift);
  return (
    isAttached(hint) &&
    !hintHasMoved(anchor, rectOf(target), shift) &&
    !isEmptyRect(drawn) &&
    hitAccepts(
      document.elementsFromPoint(drawn.left + drawn.width / 2, drawn.top + drawn.height / 2),
      (candidate) => candidate === overlayHost,
      isOurTarget(target),
    )
  );
};

/** Measure the target of one local hint again, against its anchor. */
const placementOf = (hint: LocalHint, anchor: HintRect): Placement =>
  pipe(
    isAttached(hint),
    Boolean.match({
      onFalse: () => Placement.Gone(),
      onTrue: () => {
        const now = rectOf(targetOf(hint));
        return Placement.Placed({
          shift: { dx: now.left - anchor.left, dy: now.top - anchor.top },
        });
      },
    }),
  );

/**
 * The placement of every local hint.
 *
 * A hint without an anchor has no measurement of its own, and it stays at
 * rest.
 */
const measurePlacements = (
  hints: readonly LocalHint[],
  anchors: readonly HintRect[],
): readonly Placement[] =>
  pipe(
    hints,
    Array.map((hint, index) =>
      pipe(
        anchors,
        Array.get(index),
        Option.match({ onNone: () => AT_REST, onSome: (anchor) => placementOf(hint, anchor) }),
      ),
    ),
  );

const isFocusable = (element: Element): element is HTMLElement | SVGElement =>
  element instanceof HTMLElement || element instanceof SVGElement;

/** Focus an element that can take the focus, and do not scroll to it. */
const focusQuietly: (element: Element) => void = flow(
  Option.liftPredicate(isFocusable),
  Option.match({
    onNone: constVoid,
    onSome: (focusable) => focusable.focus({ preventScroll: true }),
  }),
);

/** Some click handlers read the focused element, so a form control takes the focus first. */
const focusBeforeClick: (element: Element) => void = flow(
  Option.liftPredicate((element: Element) =>
    pipe(FOCUS_BEFORE_CLICK, Array.contains(element.localName)),
  ),
  Option.match({ onNone: constVoid, onSome: focusQuietly }),
);

/**
 * One synthetic event of the given type.
 *
 * The button state belongs to the type, and not to the sequence, so it is
 * applied here. A caller cannot forget it.
 */
const syntheticEvent = (type: string, init: MouseEventInit): MouseEvent => {
  const full: MouseEventInit = pipe(init, Struct.assign(buttonStateFor(type)));
  return pipe(
    type.startsWith("pointer") && typeof PointerEvent === "function",
    Boolean.match({
      onFalse: () => new MouseEvent(type, full),
      onTrue: () =>
        new PointerEvent(
          type,
          pipe(full, Struct.assign({ pointerType: "mouse", isPrimary: true })),
        ),
    }),
  );
};

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** A hint that was not activated. The detail is the line that the user reads. */
class HintRefused extends Schema.TaggedError<HintRefused>()("HintRefused", {
  detail: Schema.String,
}) {}

/**
 * A local activation acts for the user. A remote one is a request of another
 * document, and a clipboard mode is a capability that a page must not spend for
 * the user.
 */
const admitOrigin = (
  mode: HintMode,
  origin: ActivationOrigin,
): Result.Result<HintMode, HintRefused> =>
  pipe(
    mode,
    Result.liftPredicate(
      (mode) => origin === "local" || !writesClipboard(mode),
      () => new HintRefused({ detail: "Ignored a clipboard request from another frame." }),
    ),
  );

/** What activation does for one mode and one hint. */
type Activation = Data.TaggedEnum<{
  Click: NoFields;
  /** A new-tab mode on a hint with no URL clicks in this tab, and says so. */
  ClickHere: NoFields;
  OpenTab: { readonly url: string; readonly active: boolean };
  Hover: NoFields;
  Focus: NoFields;
  Copy: { readonly text: string; readonly label: string };
  Omnibar: { readonly href: Option.Option<string> };
  Refuse: { readonly detail: string };
}>;

const Activation = Data.taggedEnum<Activation>();

/**
 * Plan the activation of one hint.
 *
 * A synthetic Command-click does not open a new tab on WebKit, so a new-tab
 * mode reads the `href`, and goes through `Tabs.open`.
 */
const planActivation = (mode: HintMode, hint: LocalHint): Activation =>
  pipe(
    Match.value(mode),
    Match.withReturnType<Activation>(),
    Match.when("activate", () => Activation.Click()),
    Match.whenOr("activate-new-tab", "activate-new-tab-background", (tabMode) =>
      pipe(
        hint.href,
        Option.match({
          onNone: () => Activation.ClickHere(),
          onSome: (url) => Activation.OpenTab({ url, active: tabMode === "activate-new-tab" }),
        }),
      ),
    ),
    Match.when("hover", () => Activation.Hover()),
    Match.when("focus", () => Activation.Focus()),
    Match.when("copy-link-url", () =>
      pipe(
        hint.href,
        Option.match({
          onNone: () => Activation.Refuse({ detail: "That hint has no URL to copy." }),
          onSome: (url) => Activation.Copy({ text: url, label: url }),
        }),
      ),
    ),
    Match.when("copy-link-text", () =>
      Activation.Copy({ text: hint.linkText, label: "link text" }),
    ),
    Match.when("open-with-omnibar", () => Activation.Omnibar({ href: hint.href })),
    Match.when("download", () => Activation.Refuse({ detail: DOWNLOAD_DETAIL })),
    Match.exhaustive,
  );

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** Who drives a session, and who follows it. */
type SessionRole = Data.TaggedEnum<{
  /**
   * This frame drives the session.
   *
   * `crossFrame` sends each keystroke to the other frames, so they stay in
   * step. `buffered` holds the keys that arrived while the round was collected.
   */
  Origin: { readonly crossFrame: boolean; readonly buffered: readonly string[] };
  /** Another frame drives the session, and this frame draws and follows. */
  Participant: { readonly driver: FrameId };
}>;

const SessionRole = Data.taggedEnum<SessionRole>();

/** Is the session driven by this frame? */
const drivenBy = (from: FrameId): ((role: SessionRole) => boolean) =>
  SessionRole.$match({
    Origin: () => false,
    Participant: ({ driver }) => driver === from,
  });

interface SessionConfig {
  readonly roundId: string;
  readonly mode: HintMode;
  readonly entries: readonly HintEntry[];
  readonly role: SessionRole;
}

/** What one key does in a hint session. */
type SessionKey = Data.TaggedEnum<{
  Escape: NoFields;
  /** Backspace, or Delete. */
  Erase: NoFields;
  Enter: NoFields;
  /** Tab, or Shift-Tab. */
  Cycle: { readonly direction: 1 | -1 };
  /** A printable character. */
  Type: { readonly char: string };
  Ignore: NoFields;
}>;

const SessionKey = Data.taggedEnum<SessionKey>();

/** `"a"` types `"a"`, `"<space>"` types `" "`, and `"<c-a>"` does nothing. */
const readKey = (notation: string): SessionKey =>
  pipe(
    Match.value(notation),
    Match.withReturnType<SessionKey>(),
    Match.when("<esc>", () => SessionKey.Escape()),
    Match.whenOr("<backspace>", "<delete>", () => SessionKey.Erase()),
    Match.when("<enter>", () => SessionKey.Enter()),
    Match.when("<tab>", () => SessionKey.Cycle({ direction: 1 })),
    Match.when("<s-tab>", () => SessionKey.Cycle({ direction: -1 })),
    Match.when("<space>", () => SessionKey.Type({ char: " " })),
    // A key notation is one Unicode code point, or a token inside brackets.
    Match.when(
      (key) => Array.fromIterable(key).length === 1,
      (char) => SessionKey.Type({ char }),
    ),
    Match.orElse(() => SessionKey.Ignore()),
  );

/** Where a session stands, and the rules of its mode. */
type SessionState = Data.TaggedEnum<{
  /** Alphabet mode. `typed` is the queue of keystrokes, matched by prefix. */
  Alphabet: {
    readonly alphabet: string;
    readonly hints: readonly string[];
    readonly typed: string;
  };
  /**
   * Filter mode. `text` is the queue of keystrokes for the link text, and
   * `digits` is the queue of digit keystrokes. `activeIndex` is the candidate
   * that Tab moved to.
   */
  Filter: {
    readonly numbers: string;
    readonly candidates: readonly FilterCandidate[];
    readonly waitForEnter: boolean;
    readonly text: string;
    readonly digits: string;
    readonly activeIndex: number;
    readonly outcome: FilterOutcome;
  };
}>;

const SessionState = Data.taggedEnum<SessionState>();

type AlphabetState = Data.TaggedEnum.Value<SessionState, "Alphabet">;
type FilterState = Data.TaggedEnum.Value<SessionState, "Filter">;

/** How long "No matching hint" stays on screen. */
const NO_MATCH_DURATION: HudDuration = HudDuration.Transient({ duration: Duration.millis(800) });

/** What a session asks its runner to do after a key. */
type SessionCommand = Data.TaggedEnum<{
  /** Take away the confirmation that waits. */
  CancelConfirm: NoFields;
  Render: NoFields;
  /** A line for the HUD. Only the origin speaks, so the page gets one line. */
  Say: { readonly text: string; readonly duration: HudDuration };
  Exit: { readonly reason: ExitReason };
  /** Act on the entry at `index` now. */
  Activate: { readonly index: number };
  /** Act on the entry at `index` after a pause in the typing. */
  Confirm: { readonly index: number };
}>;

const SessionCommand = Data.taggedEnum<SessionCommand>();

interface Transition {
  readonly state: SessionState;
  readonly commands: readonly SessionCommand[];
}

const stay = (state: SessionState): Transition => ({ state, commands: [] });

const leave = (state: SessionState): Transition => ({
  state,
  commands: [SessionCommand.Exit({ reason: "escape" })],
});

const alphabetSession = (settings: SettingsData, entries: readonly HintEntry[]): SessionState => {
  const alphabet = normaliseHintCharacters(settings.linkHintCharacters, DEFAULT_HINT_CHARACTERS);
  return SessionState.Alphabet({
    alphabet,
    hints: hintStrings(entries.length, alphabet),
    typed: "",
  });
};

const filterSession = (settings: SettingsData, entries: readonly HintEntry[]): SessionState => {
  const numbers = normaliseHintCharacters(settings.linkHintNumbers, DEFAULT_HINT_NUMBERS);
  const candidates = pipe(
    entries,
    Array.map((entry, index) => ({ index, linkText: entry.linkText, secondary: entry.secondary })),
  );
  return SessionState.Filter({
    numbers,
    candidates,
    waitForEnter: settings.waitForEnterForFilteredHints,
    text: "",
    digits: "",
    activeIndex: 0,
    outcome: filterHints(candidates, { text: "", digits: "", numberCharacters: numbers }),
  });
};

/** The session that the settings ask for. */
const initialState = (settings: SettingsData, entries: readonly HintEntry[]): SessionState =>
  pipe(
    settings.filterLinkHints,
    Boolean.match({
      onFalse: () => alphabetSession(settings, entries),
      onTrue: () => filterSession(settings, entries),
    }),
  );

/**
 * The buffered keys that a new session replays.
 *
 * Filter mode only. In alphabet mode the buffered characters were typed
 * against hint strings that did not exist yet, so a replay would activate a
 * link that is as good as random.
 */
const replayable = (state: SessionState, keys: readonly string[]): readonly string[] =>
  pipe(
    state,
    SessionState.$match({
      Alphabet: () => Array.empty<string>(),
      Filter: () => keys,
    }),
  );

/** Is the hint at `index` exactly the keys that were typed? */
const isTypedHint =
  (hints: readonly string[], typed: string) =>
  (index: number): boolean =>
    pipe(hints, Array.get(index), Option.contains(typed));

/** What alphabet mode does with the keys typed so far. */
const alphabetFeedback = ({ hints, typed }: AlphabetState): readonly SessionCommand[] =>
  pipe(
    matchByPrefix(hints, typed),
    Array.match({
      onEmpty: () => [
        SessionCommand.Say({ text: "No matching hint", duration: NO_MATCH_DURATION }),
        SessionCommand.Exit({ reason: "explicit" }),
      ],
      onNonEmpty: (matches) =>
        pipe(
          matches,
          Option.liftPredicate((matches) => matches.length === 1),
          Option.map(Array.headNonEmpty),
          Option.filter(isTypedHint(hints, typed)),
          Option.match({
            onNone: () => [SessionCommand.Render()],
            onSome: (index) => [SessionCommand.Activate({ index })],
          }),
        ),
    }),
  );

const retype = (state: AlphabetState, typed: string): Transition => {
  const next = pipe(state, Struct.assign({ typed }));
  return {
    state: next,
    commands: pipe(alphabetFeedback(next), Array.prepend(SessionCommand.CancelConfirm())),
  };
};

const alphabetKey = (state: AlphabetState): ((key: SessionKey) => Transition) =>
  SessionKey.$match({
    Escape: () => leave(state),
    Erase: () =>
      pipe(
        state.typed,
        Option.liftPredicate(String.isNonEmpty),
        Option.match({
          onNone: () => leave(state),
          onSome: (typed) => retype(state, typed.slice(0, -1)),
        }),
      ),
    Enter: () => stay(state),
    Cycle: () => stay(state),
    Type: ({ char }) =>
      pipe(
        char.toLowerCase(),
        Option.liftPredicate((lower) => state.alphabet.includes(lower)),
        Option.match({
          onNone: () => stay(state),
          onSome: (lower) => retype(state, state.typed + lower),
        }),
      ),
    Ignore: () => stay(state),
  });

/** The query that the HUD echoes. */
const filterQuery = ({ text, digits }: FilterState): string => `${text}${digits}`.trim();

/**
 * Activate the one candidate that the query names without doubt.
 *
 * Confirmation: Enter activates at once, and so does a pause in the typing.
 * The pause matters, because filter mode narrows to one match long before the
 * user has finished the word.
 */
const exactActivation = ({ outcome, waitForEnter }: FilterState): Option.Option<SessionCommand> =>
  pipe(
    outcome.exact,
    Option.filter(() => outcome.candidates.length === 1),
    Option.map(({ index }) =>
      pipe(
        waitForEnter,
        Boolean.match({
          onFalse: () => SessionCommand.Activate({ index }),
          onTrue: () => SessionCommand.Confirm({ index }),
        }),
      ),
    ),
  );

/** What filter mode says and does after it filtered again. */
const filterFeedback = (state: FilterState): readonly SessionCommand[] =>
  pipe(
    state.outcome.candidates,
    Array.match({
      onEmpty: () => [
        SessionCommand.Say({
          text: `No matches for "${filterQuery(state)}"`,
          duration: BRIEFLY,
        }),
      ],
      onNonEmpty: () =>
        Array.getSomes([
          pipe(
            filterQuery(state),
            Option.liftPredicate(String.isNonEmpty),
            Option.map((text) => SessionCommand.Say({ text, duration: BRIEFLY })),
          ),
          exactActivation(state),
        ]),
    }),
  );

/** Filter again after a queue changed. The first candidate becomes active. */
const refilter = (state: FilterState): Transition => {
  const outcome = filterHints(state.candidates, {
    text: state.text,
    digits: state.digits,
    numberCharacters: state.numbers,
  });
  const next = pipe(state, Struct.assign({ outcome, activeIndex: 0 }));
  return {
    state: next,
    commands: pipe(
      [SessionCommand.CancelConfirm(), SessionCommand.Render()],
      Array.appendAll(filterFeedback(next)),
    ),
  };
};

/** Backspace takes the last digit, then the last character of the text, and then leaves. */
const eraseFilter = (state: FilterState): Transition =>
  pipe(
    Match.value(state),
    Match.when(
      ({ digits }) => digits.length > 0,
      (state) => pipe(state, Struct.assign({ digits: state.digits.slice(0, -1) }), refilter),
    ),
    Match.when(
      ({ text }) => text.length > 0,
      (state) => pipe(state, Struct.assign({ text: state.text.slice(0, -1) }), refilter),
    ),
    Match.orElse(leave),
  );

/** A digit goes to the digit queue, and every other character to the text. */
const typeFilter = (state: FilterState, char: string): FilterState =>
  pipe(
    state.numbers.includes(char),
    Boolean.match({
      onFalse: () => pipe(state, Struct.assign({ text: state.text + char })),
      onTrue: () => pipe(state, Struct.assign({ digits: state.digits + char })),
    }),
  );

/** Tab is an explicit "not that one". It takes away any activation that waits. */
const cycleFilter = (state: FilterState, direction: 1 | -1): Transition =>
  pipe(
    state.outcome.candidates.length,
    Option.liftPredicate((count) => count > 0),
    Option.match({
      onNone: () => stay(state),
      onSome: (count) => ({
        state: pipe(
          state,
          Struct.assign({ activeIndex: (state.activeIndex + direction + count) % count }),
        ),
        commands: [SessionCommand.CancelConfirm(), SessionCommand.Render()],
      }),
    }),
  );

const filterKey = (state: FilterState): ((key: SessionKey) => Transition) =>
  SessionKey.$match({
    Escape: () => leave(state),
    Erase: () => eraseFilter(state),
    Enter: () => ({
      state,
      commands: pipe(
        state.outcome.candidates,
        Array.get(state.activeIndex),
        Option.map(({ index }) => SessionCommand.Activate({ index })),
        Option.toArray,
      ),
    }),
    Cycle: ({ direction }) => cycleFilter(state, direction),
    Type: ({ char }) => refilter(typeFilter(state, char)),
    Ignore: () => stay(state),
  });

/** The next state of a session after one key, and what the session must do. */
const step = (state: SessionState, key: SessionKey): Transition =>
  pipe(
    state,
    SessionState.$match({
      Alphabet: (alphabet) => pipe(key, alphabetKey(alphabet)),
      Filter: (filter) => pipe(key, filterKey(filter)),
    }),
  );

/** One hint of this frame, at its position in the list of the session. */
interface OwnHint {
  readonly position: number;
  readonly localIndex: number;
  readonly secondary: boolean;
  readonly hint: LocalHint;
}

/** The entries that this frame owns, in order. */
const ownHints: (entries: readonly HintEntry[]) => readonly OwnHint[] = flow(
  Array.map((entry: HintEntry, position: number) =>
    pipe(
      entry.hint,
      Option.map((hint) => ({
        position,
        localIndex: entry.localIndex,
        secondary: entry.secondary,
        hint,
      })),
    ),
  ),
  Array.getSomes,
);

const alphabetSpec =
  ({ hints, typed }: AlphabetState, placements: readonly Placement[]) =>
  (own: OwnHint): MarkerSpec =>
    pipe(
      Option.all({
        shift: shiftAt(placements, own.localIndex),
        hintString: pipe(
          hints,
          Array.get(own.position),
          Option.filter((hint) => hint.startsWith(typed)),
        ),
      }),
      Option.match({
        onNone: () => MarkerSpec.Hidden({ secondary: own.secondary, active: false }),
        onSome: ({ shift, hintString }) =>
          MarkerSpec.Shown({
            rect: shiftedRect(own.hint.rect, shift),
            hintString,
            matchedLength: typed.length,
            secondary: own.secondary,
            active: false,
            label: Option.none(),
          }),
      }),
    );

/** The candidates of filter mode, by their position in the list of the session. */
type Shown = Record.ReadonlyRecord<string, FilterMatch>;

const filterSpec =
  (shown: Shown, active: Option.Option<number>, digits: string, placements: readonly Placement[]) =>
  (own: OwnHint): MarkerSpec => {
    const isActive = pipe(active, Option.contains(own.position));
    return pipe(
      Option.all({
        shift: shiftAt(placements, own.localIndex),
        match: pipe(shown, Record.get(`${own.position}`)),
      }),
      Option.match({
        onNone: () => MarkerSpec.Hidden({ secondary: own.secondary, active: isActive }),
        onSome: ({ shift, match }) =>
          MarkerSpec.Shown({
            rect: shiftedRect(own.hint.rect, shift),
            hintString: match.hintString,
            matchedLength: matchedPrefixLength(match.hintString, digits),
            secondary: own.secondary,
            active: isActive,
            label: own.hint.label,
          }),
      }),
    );
  };

const filterSpecs = (
  { outcome, activeIndex, digits }: FilterState,
  placements: readonly Placement[],
  own: readonly OwnHint[],
): readonly MarkerSpec[] => {
  const shown: Shown = pipe(
    outcome.candidates,
    Record.fromIterableWith((match) => [`${match.index}`, match]),
  );
  const active = pipe(
    outcome.candidates,
    Array.get(activeIndex),
    Option.map(({ index }) => index),
  );
  return pipe(own, Array.map(filterSpec(shown, active, digits, placements)));
};

/** What each marker of this frame draws, in the order of the markers. */
const markerSpecs = (
  state: SessionState,
  own: readonly OwnHint[],
  placements: readonly Placement[],
): readonly MarkerSpec[] =>
  pipe(
    state,
    SessionState.$match({
      Alphabet: (alphabet) => pipe(own, Array.map(alphabetSpec(alphabet, placements))),
      Filter: (filter) => filterSpecs(filter, placements, own),
    }),
  );

/** The live session, as the message handlers of this service see it. */
interface LiveSession {
  readonly id: number;
  readonly roundId: string;
  readonly mode: HintMode;
  readonly role: SessionRole;
  readonly key: (notation: string) => Effect.Effect<void>;
}

/** A keystroke counts inside a participant session only, and only from the frame that drives it. */
const followsKeysOf =
  (from: FrameId, roundId: string) =>
  (session: LiveSession): boolean =>
    session.roundId === roundId && drivenBy(from)(session.role);

// ---------------------------------------------------------------------------
// The rounds
// ---------------------------------------------------------------------------

/** What this frame remembers about the round that it answered. */
interface LocalRound {
  readonly roundId: string;
  readonly coordinator: FrameId;
  readonly mode: HintMode;
  readonly openedAt: number;
  /** The frame that drives the round. It is known from the `COLLECT_HINTS`. */
  readonly origin: FrameId;
}

/** What the top frame remembers about the one live round of the page. */
interface TopRound {
  readonly roundId: string;
  readonly origin: FrameId;
  readonly mode: HintMode;
  readonly startedAt: number;
  readonly cancelled: Deferred.Deferred<void>;
}

interface PendingActivation {
  readonly roundId: string;
  readonly owner: FrameId;
}

/** Is this the record of the round that `origin` owns? */
const isTopRoundOf =
  (roundId: string, origin: FrameId) =>
  (live: TopRound): boolean =>
    live.roundId === roundId && live.origin === origin;

/**
 * Does a live round of another frame keep a new round out?
 *
 * One live round for the whole page. An admitted frame could otherwise start
 * detection passes without a limit. The frame that owns the live round may
 * replace it, because a frame that asks again has left the round that it had.
 */
const blocksRound =
  (from: FrameId, now: number) =>
  (live: TopRound): boolean =>
    now - live.startedAt <= ROUND_TTL_MS && live.origin !== from;

/**
 * Does an `ACTIVATE` name the round that this frame answered?
 *
 * A round exists in this frame only after it answered a `COLLECT_HINTS`.
 * Anything else is not a round that it takes part in. The origin of a round
 * drives its own session, and it never joins as a participant.
 */
const joinsRound =
  (payload: MessageOf<"ACTIVATE">, self: FrameId, now: number) =>
  (round: LocalRound): boolean =>
    payload.originFrameId !== self &&
    now - round.openedAt <= ROUND_TTL_MS &&
    round.roundId === payload.roundId &&
    round.mode === payload.mode &&
    round.origin === payload.originFrameId;

/** What a frame does with an `ACTIVATE_HINT`. */
type HintRequest = Data.TaggedEnum<{
  /** It is not for the round of this frame, or not from the frame that drives it. */
  Ignore: NoFields;
  /** The round is too old. It is forgotten. */
  Expire: NoFields;
  Admit: NoFields;
}>;

const HintRequest = Data.taggedEnum<HintRequest>();

/**
 * Only the frame that owns the live round may drive it. This message ends in a
 * click, a hover, a focus or a clipboard write inside a document of another
 * origin.
 */
const judgeHintRequest = (
  round: Option.Option<LocalRound>,
  payload: MessageOf<"ACTIVATE_HINT">,
  from: FrameId,
  now: number,
): HintRequest =>
  pipe(
    round,
    Option.filter((round) => round.roundId === payload.roundId),
    Option.match({
      onNone: () => HintRequest.Ignore(),
      onSome: (round) =>
        pipe(
          Match.value(round),
          Match.withReturnType<HintRequest>(),
          Match.when(
            (round) => now - round.openedAt > ROUND_TTL_MS,
            () => HintRequest.Expire(),
          ),
          Match.when(
            (round) => round.origin === from && round.mode === payload.mode,
            () => HintRequest.Admit(),
          ),
          Match.orElse(() => HintRequest.Ignore()),
        ),
    }),
  );

/** A `CANCEL_HINTS` from the origin or the coordinator of this round ends it here. */
const cancelsLocalRound =
  (roundId: string, from: FrameId) =>
  (round: LocalRound): boolean =>
    round.roundId === roundId && (round.origin === from || round.coordinator === from);

/** A `CANCEL_HINTS` ends a session of the round that this frame follows. */
const cancelsSession =
  (roundId: string, from: FrameId, localRound: Option.Option<LocalRound>) =>
  (session: LiveSession): boolean =>
    session.roundId === roundId &&
    pipe(
      localRound,
      Option.exists((round) => drivenBy(from)(session.role) || round.coordinator === from),
    );

/** How the collection of a round ended. */
type Collection = Data.TaggedEnum<{
  Collected: {
    readonly local: readonly LocalHint[];
    readonly remote: readonly HintDescriptor[];
    readonly dropped: number;
  };
  /** The top frame did not answer in time. */
  Unanswered: NoFields;
  /** Escape or the safety timer ended the round. */
  Aborted: NoFields;
}>;

const Collection = Data.taggedEnum<Collection>();

type Collected = Data.TaggedEnum.Value<Collection, "Collected">;

interface HintsResult {
  readonly descriptors: readonly HintDescriptor[];
  readonly dropped: number;
}

const readHintsResult =
  (roundId: string) =>
  (reply: InboundMessage): Option.Option<HintsResult> =>
    pipe(
      reply.message,
      Option.liftPredicate((message) => message.kind === "HINTS_RESULT"),
      Option.filter((message) => message.roundId === roundId),
      Option.map((message) => ({
        descriptors: message.descriptors,
        dropped: message.droppedDescriptors,
      })),
    );

const readHints =
  (roundId: string, frameId: FrameId) =>
  (reply: InboundMessage): Option.Option<readonly HintDescriptor[]> =>
    pipe(
      reply.message,
      Option.liftPredicate((message) => message.kind === "HINTS"),
      Option.filter((message) => message.roundId === roundId && reply.from === frameId),
      // A frame speaks for itself only. To give a descriptor to the frame that
      // did not produce it breaks the shared order, which is a correctness
      // problem and not only an attack.
      Option.map((message) =>
        pipe(
          message.descriptors,
          Array.filter((descriptor) => descriptor.frameId === frameId),
        ),
      ),
    );

/** The ended rounds, with one more. The oldest go when the list is full. */
const withRound = (roundId: string): ((rounds: readonly string[]) => readonly string[]) =>
  flow(Array.union([roundId]), Array.takeRight(CANCELLED_ROUNDS_KEPT));

/** A warning for the hints that did not fit the frame message. */
const omittedNotice = (dropped: number): Option.Option<string> =>
  pipe(
    dropped,
    Option.liftPredicate((dropped) => dropped > 0),
    Option.map((dropped) => `${dropped} hints were omitted to fit the frame message.`),
  );

/**
 * The end of a handler of `FrameBus.serve` that acts on a message, and sends no
 * reply. It goes after the body, as a modifier of `Effect.fn`.
 */
const noReply = Effect.as(Option.none<FrameMessage>());

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Hints extends Context.Service<
  Hints,
  {
    /** Start a hint round in this frame. A second call replaces the first. */
    readonly activate: (mode: HintMode) => Effect.Effect<void>;
    readonly isActive: Effect.Effect<boolean>;
    readonly deactivate: Effect.Effect<void>;
  }
>()("vimium/features/hints/Hints") {
  static readonly layer: Layer.Layer<
    Hints,
    never,
    | Dom
    | Ui
    | Hud
    | Settings
    | Modes
    | Commands
    | Report
    | Capabilities
    | FrameBus
    | Tabs
    | Clipboard
  > = Layer.effect(
    Hints,
    Effect.gen(function* () {
      const dom = yield* Dom;
      const ui = yield* Ui;
      const hud = yield* Hud;
      const settings = yield* Settings;
      const modes = yield* Modes;
      const commands = yield* Commands;
      const report = yield* Report;
      const capabilities = yield* Capabilities;
      const bus = yield* FrameBus;
      const tabs = yield* Tabs;
      const clipboard = yield* Clipboard;

      /**
       * The services that the detection and the markers need.
       *
       * A session runs in a fiber of its own, and the public methods promise
       * `Effect<void>` with nothing left to supply. The context is therefore
       * captured once here and given to those effects.
       */
      const browser = yield* Effect.context<Dom | Ui>();

      // ---------------------------------------------------------------------
      // State
      // ---------------------------------------------------------------------

      /** The stylesheet that is installed, so it is not written again. */
      const cssRef = yield* Ref.make(Option.none<string>());
      /** The hints of the last detection pass of this frame. */
      const localRef = yield* Ref.make<readonly LocalHint[]>([]);
      /**
       * Where the hit target of each local hint stood at the detection pass.
       *
       * The index is the local index of the hint, which is the index that a
       * descriptor and an `ACTIVATE_HINT` carry.
       */
      const anchorsRef = yield* Ref.make<readonly HintRect[]>([]);
      /** What the last draw of each local marker knew about its target. */
      const placementsRef = yield* Ref.make<readonly Placement[]>([]);
      const warnedRef = yield* Ref.make(false);
      /**
       * The element that we pointed at last.
       *
       * A `WeakRef`, because the page can remove it at any time, and a strong
       * reference to an arbitrary node for the life of the session is a leak on
       * a page that scrolls without end.
       */
      const hoverRef = yield* Ref.make(Option.none<WeakRef<Element>>());
      const roundRef = yield* Ref.make(Option.none<LocalRound>());
      /**
       * The one live round of the page.
       *
       * Only the top frame serves `REQUEST_HINTS`, so only the top frame ever
       * holds a record here.
       */
      const topRoundRef = yield* Ref.make(Option.none<TopRound>());
      const sessionRef = yield* Ref.make(Option.none<LiveSession>());
      const sessionSeq = yield* Ref.make(0);
      const roundSeq = yield* Ref.make(0);
      const pendingActivationRef = yield* Ref.make(Option.none<PendingActivation>());
      /** The rounds that ended, oldest first. */
      const cancelledRoundsRef = yield* Ref.make<readonly string[]>([]);
      const rememberCancelled = (roundId: string): Effect.Effect<void> =>
        pipe(cancelledRoundsRef, Ref.update(withRound(roundId)));
      /** A message for a round that ended is dropped, and gets no reply. */
      const unlessCancelled = (roundId: string) =>
        pipe(
          cancelledRoundsRef,
          Ref.get,
          Effect.filterOrFail((rounds) => !pipe(rounds, Array.contains(roundId))),
          Effect.asVoid,
        );
      /** True while a round is collected, before its session exists. */
      const startingRef = yield* Ref.make(false);
      /** One session at a time. A new one interrupts the one before it. */
      const sessionFiber = yield* FiberHandle.make<void, never>();

      /** Warn about unreachable hosts once for each frame. */
      const firstWarning = (unreachableHosts: number): Effect.Effect<boolean> =>
        pipe(
          warnedRef,
          Ref.modify(
            (warned) => [unreachableHosts > 0 && !warned, warned || unreachableHosts > 0] as const,
          ),
        );

      /** Forget the one live round of the page, and wake the collection that waits on it. */
      const endTopRound = (live: TopRound): Effect.Effect<void> =>
        pipe(topRoundRef, Ref.set(Option.none()), Effect.andThen(signal(live.cancelled)));

      const broadcastCancel = (roundId: string): Effect.Effect<void> =>
        pipe(bus.broadcast({ kind: "CANCEL_HINTS", roundId }), Effect.ignore);

      // ---------------------------------------------------------------------
      // Activation
      // ---------------------------------------------------------------------

      const eventInit = (x: number, y: number): MouseEventInit => ({
        bubbles: true,
        cancelable: true,
        composed: true,
        // `document.defaultView`, and not the global: the initialiser wants a
        // true `Window`, and this is the one that the event is seen in.
        view: dom.document.defaultView,
        detail: 1,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      });

      /** The events of a pointer at the centre of `element`. */
      const eventInitAt = (element: Element): Effect.Effect<MouseEventInit> =>
        pipe(
          dom.probeOrElse(
            () => centreOf(element),
            () => ({ x: 0, y: 0 }),
          ),
          Effect.map(({ x, y }) => eventInit(x, y)),
        );

      /**
       * Measure the target of every local hint again.
       *
       * The result is the shift of each marker against the detection pass. A
       * hint whose element has left the document is marked, so that its marker
       * is hidden and its activation is refused.
       */
      const remeasure: Effect.Effect<void> = Effect.gen(function* () {
        const hints = yield* Ref.get(localRef);
        const anchors = yield* Ref.get(anchorsRef);
        const next = yield* dom.probeOrElse(() => measurePlacements(hints, anchors), Array.empty);
        yield* pipe(placementsRef, Ref.set(next));
      });

      /**
       * Is this hint still the element that the user saw at that place?
       *
       * Read the section "Revalidation" above for the reasoning. Nothing here
       * suspends, so a copy mode still writes the clipboard inside the
       * activation window of the key press.
       */
      const stillTheSameTarget = (localIndex: number, hint: LocalHint): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const anchors = yield* Ref.get(anchorsRef);
          const placements = yield* Ref.get(placementsRef);
          const host = ui.shadow.host;
          // No measurement of our own means that no round of ours drew this
          // marker. Refuse, because we cannot say what the user saw. A target
          // that is gone is refused as well.
          return yield* pipe(
            Option.all({
              anchor: pipe(anchors, Array.get(localIndex)),
              shift: shiftAt(placements, localIndex),
            }),
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: ({ anchor, shift }) =>
                dom.probeOrElse(
                  () => targetStillMatches(dom.document, host, hint, anchor, shift),
                  constFalse,
                ),
            }),
          );
        });

      const confirmTarget = (
        localIndex: number,
        hint: LocalHint,
      ): Effect.Effect<void, HintRefused> =>
        pipe(
          stillTheSameTarget(localIndex, hint),
          Effect.filterOrFail(identity, () => new HintRefused({ detail: MOVED_DETAIL })),
          Effect.asVoid,
        );

      /**
       * Focus before the click, and record the hover target.
       *
       * The record lets a later Escape undo the hover.
       */
      const prepare = Effect.fnUntraced(function* (element: Element) {
        yield* pipe(
          dom.attempt("Element.focus", () => focusBeforeClick(element)),
          Effect.ignore,
        );
        yield* pipe(hoverRef, Ref.set(Option.some(new WeakRef(element))));
      });

      /** Send one event without letting page code become our defect. */
      const dispatchOne = (
        element: Element,
        type: string,
        init: MouseEventInit,
      ): Effect.Effect<void> =>
        pipe(
          dom.attempt("Element.dispatchEvent", () => {
            element.dispatchEvent(syntheticEvent(type, init));
          }),
          Effect.ignore,
        );

      const dispatchAll = (
        element: Element,
        types: readonly string[],
        init: MouseEventInit,
      ): Effect.Effect<void> =>
        pipe(
          types,
          Effect.forEach((type) => dispatchOne(element, type, init), { discard: true }),
        );

      /** End a partial sequence and remove the hover that it started. */
      const cancelSequence = (
        element: Element,
        init: MouseEventInit,
        undo: readonly string[],
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* dispatchAll(element, undo, init);
          yield* pipe(hoverRef, Ref.set(Option.none()));
        });

      /**
       * Send a click and check after page handlers can change its target.
       *
       * Check before `mousedown` and before `click`. A failed check balances a
       * started press, removes hover, and does not send the click.
       */
      const simulateClick = Effect.fnUntraced(function* (localIndex: number, hint: LocalHint) {
        const element = hint.element;
        yield* prepare(element);
        const init = yield* eventInitAt(element);
        yield* pipe(
          CLICK_STAGES,
          Effect.forEach(
            ({ send, undo }) =>
              pipe(
                dispatchAll(element, send, init),
                Effect.andThen(confirmTarget(localIndex, hint)),
                Effect.tapError(() => cancelSequence(element, init, undo)),
              ),
            { discard: true },
          ),
        );
        yield* dispatchOne(element, "click", init);
      });

      const simulateHover = Effect.fnUntraced(function* (element: Element) {
        yield* prepare(element);
        const init = yield* eventInitAt(element);
        yield* dispatchAll(element, HOVER_SEQUENCE, init);
      });

      /** Move the pointer off an element that it hovered. */
      const leaveElement = Effect.fnUntraced(function* (element: Element) {
        const init = yield* eventInitAt(element);
        yield* pipe(
          dom.attempt("Element.dispatchEvent", () => {
            element.dispatchEvent(syntheticEvent("pointerout", init));
            element.dispatchEvent(syntheticEvent("mouseout", init));
          }),
          Effect.ignore,
        );
      });

      /**
       * Undo the last hover.
       *
       * Without this, an Escape after a hover over a navigation item leaves the
       * large menu of the site open, because the page never saw a `mouseout`.
       */
      const releaseHover: Effect.Effect<void> = Effect.gen(function* () {
        const held = yield* pipe(hoverRef, Ref.getAndSet(Option.none()));
        yield* pipe(
          held,
          Option.flatMap((reference) => Option.fromNullishOr(reference.deref())),
          Option.filter((element) => element.isConnected),
          whenSome(leaveElement),
        );
      });

      const focusElement = (element: Element): Effect.Effect<void> =>
        pipe(
          dom.attempt("Element.focus", () => focusQuietly(element)),
          Effect.ignore,
        );

      /**
       * `window.open` cannot put a tab in the background. Say so, instead of
       * letting the user believe that the setting was honoured.
       */
      const noteForeground: (active: boolean) => Effect.Effect<void> = Boolean.match({
        onFalse: () => hud.show("Opened in the foreground: there is no GM.openInTab.", BRIEFLY),
        onTrue: () => Effect.void,
      });

      const openInNewTab = Effect.fn("Hints.openInNewTab")(
        function* (url: string, active: boolean) {
          const { opened } = yield* tabs.open(url, { active });
          yield* pipe(
            opened,
            OpenInTabResult.$match({
              Manager: () => Effect.void,
              Window: () => noteForeground(active),
            }),
          );
        },
        Effect.catch((error) => report.error(error.detail)),
      );

      /**
       * Write text to the clipboard.
       *
       * The first attempt inside `Clipboard.write` does not suspend, so the
       * write still happens inside the activation window of WebKit, as long as
       * nothing in front of this call suspends.
       */
      const copy = Effect.fn("Hints.copy")(
        function* (text: string, label: string) {
          yield* clipboard.write(text);
          yield* hud.show(`Copied ${label}`, BRIEFLY);
        },
        Effect.catch((error) => report.error(`Copy failed: ${error.detail}`)),
      );

      const openOmnibar = Effect.fnUntraced(function* (href: Option.Option<string>) {
        yield* pipe(
          href,
          whenSome((text) => hud.show(text, BRIEFLY)),
        );
        yield* pipe(
          commands.run("Vomnibar.activate", {
            count: 1,
            options: {},
            event: Option.none(),
          }),
          Effect.catch((error) => report.error(error.detail)),
        );
      });

      /** Carry out the plan for one hint. */
      const perform = (
        localIndex: number,
        hint: LocalHint,
      ): ((activation: Activation) => Effect.Effect<void, HintRefused>) =>
        Activation.$match({
          Click: () => simulateClick(localIndex, hint),
          ClickHere: () =>
            pipe(
              simulateClick(localIndex, hint),
              Effect.andThen(hud.show("No link URL: activated in this tab.", BRIEFLY)),
            ),
          OpenTab: ({ url, active }) => openInNewTab(url, active),
          Hover: () => simulateHover(hint.element),
          Focus: () => focusElement(hint.element),
          Copy: ({ text, label }) => copy(text, label),
          Omnibar: ({ href }) => openOmnibar(href),
          Refuse: ({ detail }) => Effect.fail(new HintRefused({ detail })),
        });

      /** A local refusal is the line of the user. A remote one goes back to the origin. */
      const reportRefusal = (origin: ActivationOrigin, detail: string): Effect.Effect<void> =>
        pipe(
          Match.value(origin),
          Match.when("local", () => report.error(detail)),
          Match.when("remote", () => Effect.void),
          Match.exhaustive,
        );

      /**
       * Act on a hint that belongs to *this* frame, and give back why it was
       * refused.
       *
       * `origin` exists because a remote activation is an action that another
       * document asked for, and two of the modes here are capabilities that a
       * page must not spend for the user.
       */
      const activateLocal = Effect.fn("Hints.activateLocal")(
        function* (localIndex: number, hint: LocalHint, mode: HintMode, origin: ActivationOrigin) {
          yield* Effect.fromResult(admitOrigin(mode, origin));
          yield* confirmTarget(localIndex, hint);
          yield* pipe(planActivation(mode, hint), perform(localIndex, hint));
          return Option.none<string>();
        },
        (activation, _localIndex, _hint, _mode, origin) =>
          pipe(
            activation,
            Effect.catchTag("HintRefused", ({ detail }) =>
              pipe(reportRefusal(origin, detail), Effect.as(Option.some(detail))),
            ),
          ),
      );

      // ---------------------------------------------------------------------
      // Styles and detection
      // ---------------------------------------------------------------------

      // CSSOM only. A `<style>` element here obeys the `style-src` of the
      // page, and it is dropped in silence on a site with a strict policy.
      // Keyed, and not appended: the user CSS can change, and every earlier
      // version would otherwise stay in effect beside the current one.
      const installStyles = Effect.fnUntraced(function* (css: string) {
        yield* ui.setStyle("hints", css);
        yield* pipe(cssRef, Ref.set(Option.some(css)));
      });

      const ensureStyles = Effect.gen(function* () {
        const current = yield* settings.current;
        const css = hintCss(current.userDefinedLinkHintCss);
        const installed = yield* Ref.get(cssRef);
        yield* pipe(
          installed,
          Option.filter((installed) => installed === css),
          Option.match({ onNone: () => installStyles(css), onSome: () => Effect.void }),
        );
      });

      const detectLocal = Effect.fn("Hints.detect")(function* (mode: HintMode) {
        const viewport = yield* ui.viewport;
        const result = yield* pipe(
          detectHints({
            window: dom.window,
            document: dom.document,
            capabilities,
            viewport,
            targets: targetsFor(mode),
            overlayHost: Option.some(ui.shadow.host),
          }),
          Effect.provideContext(browser),
        );

        // A closed shadow root gives `null` from `element.shadowRoot` by
        // design, and a patch of `attachShadow` needs a reliable
        // `document-start` that WebKit does not give a userscript. To tell the
        // user is better than a silent gap.
        yield* pipe(
          hud.show("Some elements on this page cannot be reached (closed shadow DOM).", BRIEFLY),
          Effect.when(firstWarning(result.unreachableHosts)),
        );

        yield* pipe(localRef, Ref.set(result.hints));
        // The anchors of this pass. They are measured now, and not from the
        // rects of the detection, because a hint rect is cropped to the visible
        // region and an `<area>` takes its geometry from its image.
        const anchors: readonly HintRect[] = yield* dom.probeOrElse(
          () => pipe(result.hints, Array.map(flow(targetOf, rectOf))),
          Array.empty,
        );
        yield* pipe(anchorsRef, Ref.set(anchors));
        yield* pipe(placementsRef, Ref.set(NO_PLACEMENTS));
        return result.hints;
      });

      /** Merge our own hints with those of the other frames, in one order. */
      const merge = (
        local: readonly LocalHint[],
        remote: readonly HintDescriptor[],
      ): readonly HintEntry[] =>
        pipe(
          remote,
          // A cross-frame payload contains the complete bounded list. This
          // keeps the byte decision identical in every frame. A local round
          // builds its list from its own detection result.
          Array.match({
            onEmpty: () => descriptorsFor(bus.frameId, local),
            onNonEmpty: identity,
          }),
          limitDescriptors,
          Array.map(entryFor(bus.frameId, local)),
        );

      // ---------------------------------------------------------------------
      // The session
      // ---------------------------------------------------------------------

      const runSession = Effect.fnUntraced(function* (config: SessionConfig) {
        const current = yield* settings.current;
        const keyContext = keyContextFor(current, capabilities.applePlatform);
        const initial = initialState(current, config.entries);
        const own = ownHints(config.entries);
        const state = yield* Ref.make(initial);

        const markers = yield* pipe(makeMarkerLayer, Effect.provideContext(browser));
        const done = yield* Deferred.make<void>();
        const finish = signal(done);
        const confirm = yield* FiberHandle.make<void, never>();

        /**
         * Take away the confirmation that waits.
         *
         * `FiberHandle.run` with an effect that does nothing, and not
         * `FiberHandle.clear`. `clear` waits for the interruption of the
         * fiber, and this runs inside a `keydown`, where nothing may
         * suspend. `run` replaces the fiber and does not wait.
         */
        const cancelConfirm: Effect.Effect<void> = pipe(
          Effect.void,
          FiberHandle.run(confirm),
          Effect.asVoid,
        );
        const handleRef = yield* Ref.make(Option.none<ModeHandle>());
        const id = yield* pipe(
          sessionSeq,
          Ref.modify((n) => [n, n + 1] as const),
        );

        const exitSession = (reason: ExitReason): Effect.Effect<void> =>
          pipe(
            handleRef,
            Ref.get,
            Effect.flatMap(
              Option.match({ onNone: () => finish, onSome: (handle) => handle.exit(reason) }),
            ),
          );

        const isLive: Effect.Effect<boolean> = pipe(
          handleRef,
          Ref.get,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: (handle) => handle.isActive,
            }),
          ),
        );

        // -- rendering ---------------------------------------------------

        const render: Effect.Effect<void> = Effect.gen(function* () {
          const snapshot = yield* Ref.get(state);
          const placements = yield* Ref.get(placementsRef);
          yield* markers.render(markerSpecs(snapshot, own, placements));
        });

        /**
         * Draw the markers again where their targets are now.
         *
         * The layer translation follows a scroll of the page only. A
         * container that scrolls inside the page, a resize and a reflow move
         * one target and not the layer. The targets are therefore measured
         * again, the layer takes the scroll position of now, and the markers
         * are drawn at the new rects.
         */
        const refresh: Effect.Effect<void> = Effect.gen(function* () {
          yield* remeasure;
          yield* markers.reanchor;
          yield* render;
        });

        // One pass for each animation frame. A scroll arrives far more often
        // than we can usefully measure and draw again.
        const layout = yield* FiberHandle.make<void, never>();
        const onLayoutChange = pipe(
          dom.nextFrame,
          Effect.andThen(refresh),
          FiberHandle.run(layout),
          Effect.asVoid,
        );

        // The capture phase: a scroll does not bubble from the element that
        // scrolls, and a hint inside an inner scroller must follow it.
        yield* dom.listen("document", "scroll", () => onLayoutChange, {
          capture: true,
          passive: true,
        });
        yield* dom.listen("window", "resize", () => onLayoutChange, {
          passive: true,
        });
        yield* dom.listenOn(dom.document.fonts, "loadingdone", () => onLayoutChange, {
          passive: true,
        });

        // -- activation --------------------------------------------------

        /** The origin asks the frame that owns the entry to act. */
        const activateRemote = Effect.fnUntraced(function* (entry: HintEntry) {
          yield* pipe(
            pendingActivationRef,
            Ref.set(Option.some({ roundId: config.roundId, owner: entry.frameId })),
          );
          yield* pipe(
            bus.send(toFrame(entry.frameId), {
              kind: "ACTIVATE_HINT",
              roundId: config.roundId,
              localIndex: entry.localIndex,
              mode: config.mode,
            }),
            Effect.ignore,
          );
        });

        /**
         * Detached and started at once, so that the clipboard write of a copy
         * mode still happens inside the activation window, and so that a mode
         * which must wait does not suspend the key path.
         */
        const activateHere = (entry: HintEntry, hint: LocalHint): Effect.Effect<void> =>
          pipe(
            activateLocal(entry.localIndex, hint, config.mode, "local"),
            Effect.forkDetach({ startImmediately: true }),
            Effect.asVoid,
          );

        // A participant draws and follows, and the origin is the frame that
        // acts. It acts here, or it addresses the frame that owns the entry,
        // which can be this frame as well.
        const act = (entry: HintEntry): Effect.Effect<void> =>
          pipe(
            config.role,
            SessionRole.$match({
              Origin: () =>
                pipe(
                  entry.hint,
                  Option.match({
                    onNone: () => activateRemote(entry),
                    onSome: (hint) => activateHere(entry, hint),
                  }),
                ),
              Participant: () => Effect.void,
            }),
          );

        const activateIndex = (index: number): Effect.Effect<void> =>
          pipe(
            config.entries,
            Array.get(index),
            // The overlay goes first: activation can move the focus, and a
            // marker that is still drawn would be visible for one frame after
            // a navigation starts.
            whenSome((entry) => pipe(exitSession("explicit"), Effect.andThen(act(entry)))),
          );

        // -- keys --------------------------------------------------------

        /** Only the origin speaks: one HUD message for the page, and not one for each frame. */
        const say = (text: string, duration: HudDuration): Effect.Effect<void> =>
          pipe(
            config.role,
            SessionRole.$match({
              Origin: () => hud.show(text, duration),
              Participant: () => Effect.void,
            }),
          );

        const run = SessionCommand.$match({
          CancelConfirm: () => cancelConfirm,
          Render: () => render,
          Say: ({ text, duration }) => say(text, duration),
          Exit: ({ reason }) => exitSession(reason),
          Activate: ({ index }) => activateIndex(index),
          Confirm: ({ index }) =>
            pipe(
              Effect.sleep(FILTER_CONFIRM_DELAY_MS),
              Effect.andThen(activateIndex(index)),
              FiberHandle.run(confirm),
              Effect.asVoid,
            ),
        });

        const applyKey = Effect.fnUntraced(function* (notation: string) {
          const before = yield* Ref.get(state);
          const { state: after, commands } = step(before, readKey(notation));
          yield* pipe(state, Ref.set(after));
          yield* pipe(commands, Effect.forEach(run, { discard: true }));
        });

        const handleKey = (notation: string): Effect.Effect<void> =>
          pipe(applyKey(notation), Effect.when(isLive), Effect.asVoid);

        const broadcastKey = (notation: string): Effect.Effect<void> =>
          pipe(
            bus.broadcast({ kind: "KEYSTROKE", roundId: config.roundId, notation }),
            Effect.ignore,
          );

        const relay = (notation: string): Effect.Effect<void> =>
          pipe(
            config.role,
            SessionRole.$match({
              Origin: ({ crossFrame }) =>
                pipe(
                  crossFrame,
                  Boolean.match({
                    onFalse: () => Effect.void,
                    onTrue: () => broadcastKey(notation),
                  }),
                ),
              // A key reaches a participant over the relay. To send it back
              // would loop.
              Participant: () => Effect.void,
            }),
          );

        // Escape tears the origin session down. Relay it first, while the
        // round is still live, so that a participant removes its markers as
        // well. An activation key stays local first, because a copy mode needs
        // the activation of this keystroke.
        const dispatchKey = (key: string): Effect.Effect<void> =>
          pipe(
            key === "<esc>",
            Boolean.match({
              onFalse: () => pipe(handleKey(key), Effect.andThen(relay(key))),
              onTrue: () => pipe(relay(key), Effect.andThen(handleKey(key))),
            }),
          );

        const onKeydown = (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
          pipe(
            event,
            // A keystroke in the middle of a composition belongs to the input
            // method, and not to us.
            Option.liftPredicate(Predicate.not(isComposing)),
            Option.flatMap((event) => keyNotation(event, keyContext)),
            whenSome(dispatchKey),
            Effect.as(SUPPRESS_EVENT),
          );

        // -- the mode ----------------------------------------------------

        const handle = yield* modes.enter(
          {
            name: "hints",
            indicator: pipe(INDICATORS, Struct.get(config.mode), Option.some),
            // Hint mode handles Escape itself, because the origin must relay it
            // before the teardown. The generic exit would run first.
            exitOn: [],
            // Hint mode owns the keyboard: a key that we do not use must not
            // reach the page, or `j` scrolls while the user picks a link.
            keyboard: KeyPolicy.Owned(),
            singleton: Option.some("hints"),
          },
          { keydown: onKeydown },
        );

        yield* pipe(handleRef, Ref.set(Option.some(handle)));

        const onExit = Effect.fnUntraced(function* (reason: ExitReason) {
          yield* cancelConfirm;
          yield* markers.clear;
          // Escape means "undo what I was pointing at". An explicit
          // activation means that the hover was wanted, and it must stay.
          yield* pipe(reason, whenEscaped(releaseHover));
          yield* finish;
        });
        yield* handle.onExit(onExit);

        const session: LiveSession = {
          id,
          roundId: config.roundId,
          mode: config.mode,
          role: config.role,
          key: handleKey,
        };

        /** The origin keeps the HUD while it waits for the frame that it asked to act. */
        const awaitsActivation: Effect.Effect<boolean> = pipe(
          config.role,
          SessionRole.$match({
            Origin: () =>
              pipe(
                pendingActivationRef,
                Ref.get,
                Effect.map(Option.exists((pending) => pending.roundId === config.roundId)),
              ),
            Participant: () => Effect.succeed(false),
          }),
        );

        // The HUD goes here, and not in the exit body of the mode. `Hud.hide`
        // waits for the timer fiber of the message before it, and the exit
        // body of the mode runs inside a `keydown`, where nothing may
        // suspend. A finaliser runs in the fiber of the session.
        yield* Effect.addFinalizer(() =>
          pipe(
            awaitsActivation,
            Effect.flatMap(Boolean.match({ onFalse: () => hud.hide, onTrue: () => Effect.void })),
          ),
        );

        const publish = pipe(sessionRef, Ref.set(Option.some(session)));
        yield* Effect.acquireRelease(publish, () =>
          pipe(sessionRef, Ref.update(Option.filter((live) => live.id !== id))),
        );

        // The top frame holds the record of the one live round. When this
        // frame is both the top frame and the origin, no `KEYSTROKE` comes
        // back to it, so the record is cleared here instead. Any other frame
        // holds no record, and the update leaves it empty.
        yield* Effect.addFinalizer(() =>
          pipe(
            config.role,
            SessionRole.$match({
              Origin: () =>
                pipe(
                  topRoundRef,
                  Ref.update(
                    Option.filter(Predicate.not(isTopRoundOf(config.roundId, bus.frameId))),
                  ),
                ),
              Participant: () => Effect.void,
            }),
          ),
        );

        // The first draw measures the targets, because the page can move
        // between the detection pass and this moment. Every later draw uses
        // the measurements of the last layout change.
        yield* refresh;

        // A key after the end of the session does nothing, so the replay
        // stops there.
        const replay = pipe(
          config.role,
          SessionRole.$match({
            Origin: ({ buffered }) => replayable(initial, buffered),
            Participant: () => Array.empty<string>(),
          }),
        );
        yield* pipe(replay, Effect.forEach(handleKey, { discard: true }));

        yield* Deferred.await(done);
      });

      const beginSession = (config: SessionConfig): Effect.Effect<void> =>
        pipe(runSession(config), Effect.scoped, FiberHandle.run(sessionFiber), Effect.asVoid);

      // ---------------------------------------------------------------------
      // The round, as the origin frame runs it
      // ---------------------------------------------------------------------

      /**
       * Swallow and record the keys while the hints are collected.
       *
       * Collection is time-boxed, and a user who has already typed `fab` must
       * not lose the `ab`. The safety timer exists because the other failure —
       * a page whose keyboard is dead because a frame hangs — is far worse than
       * a few keystrokes that are dropped.
       */
      const bufferKeys = Effect.fnUntraced(function* (
        keys: Ref.Ref<readonly string[]>,
        abort: Deferred.Deferred<void>,
      ) {
        const current = yield* settings.current;
        const keyContext = keyContextFor(current, capabilities.applePlatform);
        const handle = yield* modes.enter(
          {
            name: "hints/buffer",
            indicator: Option.none(),
            exitOn: [ExitTrigger.Escape()],
            keyboard: KeyPolicy.Owned(),
            singleton: Option.some("hints"),
          },
          {
            keydown: (event) =>
              pipe(
                keyNotation(event, keyContext),
                Option.filter((key) => key !== "<esc>"),
                whenSome((key) => pipe(keys, Ref.update(Array.append(key)))),
                Effect.as(SUPPRESS_EVENT),
              ),
          },
        );

        yield* handle.onExit(whenEscaped(signal(abort)));

        const giveUp = pipe(
          handle.exit("explicit"),
          Effect.andThen(hud.show(HINTS_STOPPED, BRIEFLY)),
        );
        yield* pipe(abortAfterSafety(abort, giveUp), Effect.forkScoped);
      });

      const collectRemote = Effect.fn("Hints.collectRemote")(function* (
        roundId: string,
        mode: HintMode,
      ) {
        const peers = yield* bus.peers;
        return yield* pipe(
          peers.length <= 1,
          Boolean.match({
            // One frame is this frame. There is nobody to ask.
            onTrue: () =>
              Effect.succeedSome<HintsResult>({
                descriptors: Array.empty<HintDescriptor>(),
                dropped: 0,
              }),
            onFalse: () =>
              pipe(
                bus.request(
                  toTop,
                  { kind: "REQUEST_HINTS", roundId, mode },
                  readHintsResult(roundId),
                  COLLECT_DEADLINE_MS,
                ),
                Effect.option,
              ),
          }),
        );
      });

      /** Collect the hints of every frame, and buffer the keys meanwhile. */
      const collectRound = Effect.fnUntraced(function* (
        roundId: string,
        mode: HintMode,
        buffered: Ref.Ref<readonly string[]>,
        abort: Deferred.Deferred<void>,
      ) {
        const claim = pipe(startingRef, Ref.set(true));
        yield* Effect.acquireRelease(claim, () => pipe(startingRef, Ref.set(false)));
        yield* bufferKeys(buffered, abort);
        const local = yield* detectLocal(mode);
        const remote = yield* collectRemote(roundId, mode);
        return pipe(
          remote,
          Option.match({
            onNone: (): Collection => Collection.Unanswered(),
            onSome: ({ descriptors, dropped }): Collection =>
              Collection.Collected({ local, remote: descriptors, dropped }),
          }),
          Option.some,
        );
      });

      /** End a round that never opened, in this frame and in every other one. */
      const cancelRound = Effect.fnUntraced(function* (roundId: string) {
        yield* rememberCancelled(roundId);
        const topRound = yield* Ref.get(topRoundRef);
        yield* pipe(
          topRound,
          Option.filter(isTopRoundOf(roundId, bus.frameId)),
          whenSome(endTopRound),
        );
        yield* pipe(roundRef, Ref.update(Option.filter((round) => round.roundId !== roundId)));
        yield* broadcastCancel(roundId);
      });

      /** Open the session of a round that this frame collected. */
      const openRound = Effect.fnUntraced(function* (
        roundId: string,
        mode: HintMode,
        buffered: Ref.Ref<readonly string[]>,
        { local, remote, dropped }: Collected,
      ) {
        const entries = merge(local, remote);
        const start = Effect.gen(function* () {
          yield* pipe(
            omittedNotice(dropped),
            whenSome((text) => hud.show(text, BRIEFLY)),
          );
          const keys = yield* Ref.get(buffered);
          yield* pipe(
            runSession({
              roundId,
              mode,
              entries,
              role: SessionRole.Origin({ crossFrame: remote.length > 0, buffered: keys }),
            }),
            Effect.scoped,
          );
        });
        yield* pipe(
          entries,
          Array.match({
            onEmpty: () => hud.show("No links to select", BRIEFLY),
            onNonEmpty: () => start,
          }),
        );
      });

      const startRound = Effect.fn("Hints.startRound")(function* (mode: HintMode) {
        yield* ensureStyles;
        yield* pipe(pendingActivationRef, Ref.set(Option.none()));

        const sequence = yield* pipe(
          roundSeq,
          Ref.modify((n) => [n, n + 1] as const),
        );
        const roundId = `${bus.frameId}-${sequence}`;
        const buffered = yield* Ref.make<readonly string[]>([]);
        const abort = yield* Deferred.make<void>();

        // The buffer starts at the first moment: detection is chunked, and so
        // it is asynchronous even in one frame, and a fast typist gets ahead of
        // it.
        const collect = pipe(collectRound(roundId, mode, buffered, abort), Effect.scoped);

        // Escape during the collection ends the round, and so does the safety
        // timer. The loser of the race is interrupted, which stops the
        // detection at its next slice.
        const collection = yield* pipe(
          raceUntilAbort(collect, abort),
          Effect.map(Option.getOrElse((): Collection => Collection.Aborted())),
        );
        yield* pipe(
          collection,
          Collection.$match({
            Aborted: () => cancelRound(roundId),
            Unanswered: () =>
              pipe(hud.show(HINTS_STOPPED, BRIEFLY), Effect.andThen(cancelRound(roundId))),
            Collected: (collected) => openRound(roundId, mode, buffered, collected),
          }),
        );
      });

      // ---------------------------------------------------------------------
      // The round, as the top frame runs it
      // ---------------------------------------------------------------------

      /** Ask one frame for its descriptors. A frame that does not answer gives none. */
      const requestFrameHints =
        (origin: FrameId, roundId: string, mode: HintMode) =>
        (frameId: FrameId): Effect.Effect<readonly HintDescriptor[]> =>
          pipe(
            bus.request(
              toFrame(frameId),
              {
                kind: "COLLECT_HINTS",
                roundId,
                originFrameId: origin,
                mode,
              },
              readHints(roundId, frameId),
              REQUEST_DEADLINE,
            ),
            Effect.orElseSucceed(() => Array.empty<HintDescriptor>()),
          );

      /**
       * Ask every frame for its descriptors, and give them back in the one
       * order that every frame must agree on.
       *
       * The origin is asked as well, although it has already run its own
       * detection. Without its descriptors the other frames would work out
       * another assignment of the hint strings, and the whole scheme rests on
       * every frame agreeing.
       */
      const collectEveryFrame = Effect.fn("Hints.collectEveryFrame")(function* (
        origin: FrameId,
        roundId: string,
        mode: HintMode,
      ) {
        const peers = yield* bus.peers;
        return yield* collectFrameDescriptors(peers, requestFrameHints(origin, roundId, mode));
      });

      /** Give the ordered descriptors to every frame except the origin. */
      const activateEveryFrame = Effect.fnUntraced(function* (
        origin: FrameId,
        roundId: string,
        mode: HintMode,
        descriptors: readonly HintDescriptor[],
      ) {
        const peers = yield* bus.peers;
        yield* pipe(
          peers,
          Array.filter((frameId) => frameId !== origin),
          Effect.forEach(
            (frameId) =>
              pipe(
                bus.send(toFrame(frameId), {
                  kind: "ACTIVATE",
                  roundId,
                  originFrameId: origin,
                  mode,
                  descriptors,
                }),
                Effect.ignore,
              ),
            { discard: true },
          ),
        );
      });

      const runHintRound = Effect.fn("Hints.runHintRound")(function* (
        origin: FrameId,
        roundId: string,
        mode: HintMode,
        cancelled: Deferred.Deferred<void>,
      ) {
        const collect = pipe(collectEveryFrame(origin, roundId, mode), Effect.asSome);
        const collected = yield* raceUntilAbort(collect, cancelled);
        const live = yield* Ref.get(topRoundRef);
        // The answers count only while the round that asked for them is live.
        const round = pipe(
          collected,
          Option.flatMap((result) =>
            pipe(
              live,
              Option.filter((live) => live.roundId === roundId),
              Option.as(result),
            ),
          ),
        );
        yield* pipe(
          round,
          whenSome(({ descriptors }) => activateEveryFrame(origin, roundId, mode, descriptors)),
        );
        return round;
      });

      // ---------------------------------------------------------------------
      // The messages that this service answers
      // ---------------------------------------------------------------------

      // `FrameBus.serve` gives each handler the messages of its kind only. A
      // handler that drops a message fails with `NoSuchElementError`, and
      // `Effect.option` turns that into no reply.

      const answerRequestHints = Effect.fnUntraced(function* ({
        message: { roundId, mode },
        from,
      }: InboundOf<"REQUEST_HINTS">) {
        yield* unlessCancelled(roundId);
        const now = yield* dom.now;
        const live = yield* pipe(
          topRoundRef,
          Ref.get,
          Effect.filterOrFail(Predicate.not(Option.exists(blocksRound(from, now)))),
        );
        yield* pipe(
          live,
          whenSome((replaced) => signal(replaced.cancelled)),
        );
        const cancelled = yield* Deferred.make<void>();
        yield* pipe(
          topRoundRef,
          Ref.set(Option.some({ roundId, origin: from, mode, startedAt: now, cancelled })),
        );
        const { descriptors, dropped } = yield* pipe(
          runHintRound(from, roundId, mode, cancelled),
          Effect.flatMap((round) => Effect.fromOption(round)),
        );
        return {
          kind: "HINTS_RESULT" as const,
          roundId,
          droppedDescriptors: dropped,
          descriptors,
        };
      }, Effect.option);

      const answerCollectHints = Effect.fnUntraced(function* ({
        message: { roundId, mode, originFrameId },
        from,
      }: InboundOf<"COLLECT_HINTS">) {
        yield* unlessCancelled(roundId);
        const hints = yield* detectLocal(mode);
        yield* unlessCancelled(roundId);
        const now = yield* dom.now;
        // The round of this frame opens here, and its age is bounded. It is
        // bounded by time and not by "a mode is live", because the origin
        // frame tears its own mode down before it acts.
        yield* pipe(
          roundRef,
          Ref.set(
            Option.some({
              roundId,
              coordinator: from,
              mode,
              openedAt: now,
              origin: originFrameId,
            }),
          ),
        );
        return {
          kind: "HINTS" as const,
          roundId,
          descriptors: descriptorsFor(bus.frameId, hints),
        };
      }, Effect.option);

      /** Join the session of a round that another frame drives. */
      const joinRound = Effect.fnUntraced(function* (payload: MessageOf<"ACTIVATE">) {
        yield* ensureStyles;
        const local = yield* Ref.get(localRef);
        // `local` is the answer of this frame to `COLLECT_HINTS`. The
        // complete descriptor list gives every frame the same byte limit.
        const entries = merge(local, payload.descriptors);
        const participate = beginSession({
          roundId: payload.roundId,
          mode: payload.mode,
          entries,
          role: SessionRole.Participant({ driver: payload.originFrameId }),
        });
        yield* pipe(
          entries,
          Array.match({ onEmpty: () => Effect.void, onNonEmpty: () => participate }),
        );
      });

      const onActivate = Effect.fnUntraced(function* ({ message: payload }: InboundOf<"ACTIVATE">) {
        const round = yield* Ref.get(roundRef);
        const now = yield* dom.now;
        yield* pipe(
          round,
          Option.filter(joinsRound(payload, bus.frameId, now)),
          whenSome(() => joinRound(payload)),
        );
      }, noReply);

      /** Act on a hint of this frame for the origin, and tell the origin how it went. */
      const actForOrigin = Effect.fnUntraced(function* (
        payload: MessageOf<"ACTIVATE_HINT">,
        hint: LocalHint,
      ) {
        // One activation for each round, so that one authorised request
        // cannot be replayed into a click on every element that this frame
        // ever hinted.
        yield* pipe(roundRef, Ref.set(Option.none()));
        const refusal = yield* activateLocal(payload.localIndex, hint, payload.mode, "remote");
        yield* pipe(
          bus.broadcast({
            kind: "ACTIVATION_RESULT",
            roundId: payload.roundId,
            detail: pipe(
              refusal,
              Option.getOrElse(() => ""),
            ),
          }),
          Effect.ignore,
        );
      });

      const admitHintRequest = Effect.fnUntraced(function* (payload: MessageOf<"ACTIVATE_HINT">) {
        const hints = yield* Ref.get(localRef);
        yield* pipe(
          hints,
          Array.get(payload.localIndex),
          whenSome((hint) => actForOrigin(payload, hint)),
        );
      });

      const onActivateHint = Effect.fnUntraced(function* ({
        message: payload,
        from,
      }: InboundOf<"ACTIVATE_HINT">) {
        const round = yield* Ref.get(roundRef);
        const now = yield* dom.now;
        yield* pipe(
          judgeHintRequest(round, payload, from, now),
          HintRequest.$match({
            Ignore: () => Effect.void,
            Expire: () => pipe(roundRef, Ref.set(Option.none())),
            Admit: () => admitHintRequest(payload),
          }),
        );
      }, noReply);

      const onCancelHints = Effect.fnUntraced(function* ({
        message: { roundId },
        from,
      }: InboundOf<"CANCEL_HINTS">) {
        yield* rememberCancelled(roundId);

        const localRound = yield* Ref.get(roundRef);
        yield* pipe(
          localRound,
          Option.filter(cancelsLocalRound(roundId, from)),
          whenSome(() => pipe(roundRef, Ref.set(Option.none()))),
        );

        const topRound = yield* Ref.get(topRoundRef);
        yield* pipe(
          topRound,
          Option.filter(isTopRoundOf(roundId, from)),
          whenSome((live) => pipe(endTopRound(live), Effect.andThen(broadcastCancel(roundId)))),
        );

        const session = yield* Ref.get(sessionRef);
        yield* pipe(
          session,
          Option.filter(cancelsSession(roundId, from, localRound)),
          whenSome(() => FiberHandle.clear(sessionFiber)),
        );
        yield* pipe(
          pendingActivationRef,
          Ref.update(Option.filter((pending) => pending.roundId !== roundId)),
        );
      }, noReply);

      const settled = Effect.gen(function* () {
        yield* pipe(pendingActivationRef, Ref.set(Option.none()));
        yield* hud.hide;
      });

      /** An empty detail is a success. Anything else is the refusal of the owner. */
      const settleActivation: (detail: string) => Effect.Effect<void> = flow(
        Option.liftPredicate(String.isNonEmpty),
        Option.match({ onNone: () => settled, onSome: (refusal) => report.error(refusal) }),
      );

      const onActivationResult = Effect.fnUntraced(function* ({
        message: { roundId, detail },
        from,
        requestId,
      }: InboundOf<"ACTIVATION_RESULT">) {
        const pending = yield* Ref.get(pendingActivationRef);
        yield* pipe(
          pending,
          Option.filter(
            (pending) =>
              Option.isNone(requestId) && pending.roundId === roundId && pending.owner === from,
          ),
          whenSome(() => settleActivation(detail)),
        );
      }, noReply);

      const onKeystroke = Effect.fnUntraced(function* ({
        message: { roundId, notation },
        from,
      }: InboundOf<"KEYSTROKE">) {
        // The round of the page ends when the frame that owns it leaves.
        yield* pipe(
          topRoundRef,
          Ref.update(
            Option.filter((live) => !(notation === "<esc>" && isTopRoundOf(roundId, from)(live))),
          ),
        );
        // A keystroke means something inside a round only, and only from the
        // frame that the user types into.
        const live = yield* Ref.get(sessionRef);
        yield* pipe(
          live,
          Option.filter(followsKeysOf(from, roundId)),
          whenSome((session) => session.key(notation)),
        );
      }, noReply);

      // The top frame is the broker of the round. A child frame asks it, and
      // it fans the request out to every frame.
      yield* pipe(
        bus.role,
        FrameRole.$match({
          Top: () => bus.serve("REQUEST_HINTS", answerRequestHints),
          Child: () => Effect.void,
        }),
      );
      yield* bus.serve("COLLECT_HINTS", answerCollectHints);
      yield* bus.serve("ACTIVATE", onActivate);
      yield* bus.serve("ACTIVATE_HINT", onActivateHint);
      yield* bus.serve("CANCEL_HINTS", onCancelHints);
      yield* bus.serve("ACTIVATION_RESULT", onActivationResult);
      yield* bus.serve("KEYSTROKE", onKeystroke);

      // ---------------------------------------------------------------------
      // The interface
      // ---------------------------------------------------------------------

      const isActive: Effect.Effect<boolean> = Effect.gen(function* () {
        const starting = yield* Ref.get(startingRef);
        const live = yield* Ref.get(sessionRef);
        return starting || Option.isSome(live);
      });

      const deactivate: Effect.Effect<void> = Effect.gen(function* () {
        const live = yield* Ref.get(sessionRef);
        const starting = yield* Ref.get(startingRef);
        yield* FiberHandle.clear(sessionFiber);
        yield* pipe(
          Option.isSome(live) || starting,
          Boolean.match({ onFalse: () => Effect.void, onTrue: () => releaseHover }),
        );
      });

      const service = Hints.of({
        activate: (mode) => pipe(startRound(mode), FiberHandle.run(sessionFiber), Effect.asVoid),
        isActive,
        deactivate,
      });

      yield* commands.registerAll({
        "LinkHints.activateMode": () => service.activate("activate"),
        "LinkHints.activateModeToOpenInNewTab": () =>
          service.activate("activate-new-tab-background"),
        "LinkHints.activateModeToOpenInNewForegroundTab": () =>
          service.activate("activate-new-tab"),
        "LinkHints.activateModeToHover": () => service.activate("hover"),
        "LinkHints.activateModeToFocus": () => service.activate("focus"),
        "LinkHints.activateModeToCopyLinkUrl": () => service.activate("copy-link-url"),
        "LinkHints.activateModeToCopyLinkText": () => service.activate("copy-link-text"),
        "LinkHints.activateModeWithOmnibar": () => service.activate("open-with-omnibar"),
      });

      return service;
    }),
  );
}
