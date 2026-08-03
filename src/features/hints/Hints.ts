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
 */

import {
  Context,
  Deferred,
  Effect,
  FiberHandle,
  Layer,
  Option,
  Ref,
  Result,
  type Scope,
} from "effect";
import { Commands } from "~/core/Commands.ts";
import { type HandlerResult, SUPPRESS_EVENT } from "~/core/HandlerStack.ts";
import { type ExitReason, type ModeHandle, Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import {
  type FrameMessage,
  type HintDescriptor,
  type HintMode,
  REQUEST_DEADLINE_MS,
  sortDescriptors,
} from "~/domain/FrameMessage.ts";
import {
  type FilterCandidate,
  filterHints,
  type FilterMatch,
  type FilterOutcome,
  matchedPrefixLength,
} from "~/domain/HintFilter.ts";
import {
  hintStrings,
  matchByPrefix,
  normaliseHintCharacters,
} from "~/domain/HintString.ts";
import { isComposing, type KeyContext, keyNotation } from "~/domain/Key.ts";
import {
  FrameBus,
  type InboundMessage,
  REQUEST_DEADLINE,
  toFrame,
  toTop,
} from "~/frames/Bus.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Clipboard } from "~/platform/Clipboard.ts";
import { Dom } from "~/platform/Dom.ts";
import type { FrameId } from "~/platform/Realm.ts";
import { Tabs } from "~/platform/Tabs.ts";
import { Hud } from "~/ui/Hud.ts";
import { Ui } from "~/ui/Ui.ts";
import { detectHints, type LocalHint } from "./Detect.ts";
import { hintCss, makeMarkerLayer, type MarkerSpec } from "./Markers.ts";

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
const COLLECT_DEADLINE_MS = REQUEST_DEADLINE_MS + 500;

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
export const KEY_BUFFER_SAFETY_MS = 1000;

/** The alphabet that is used when the setting cannot give a usable one. */
const DEFAULT_HINT_CHARACTERS = "sadfjklewcmpgh";

/** The digits that are used when the setting cannot give a usable set. */
const DEFAULT_HINT_NUMBERS = "0123456789";

/** The ceiling on the link text of a descriptor. It is the bound of the wire. */
const MAX_WIRE_LINK_TEXT = 256;

/**
 * The ceiling on the descriptors of one frame. It is the bound of the wire.
 *
 * A frame that gives five thousand hints is already past the point where hints
 * help the user, and a longer array is refused by the schema of the receiver.
 */
const MAX_WIRE_DESCRIPTORS = 5000;

/**
 * The full sequence of events that a true click produces.
 *
 * A partial sequence is the reason that "the hint did nothing" reports exist.
 * The synthetic-event bridge of React listens for `pointerdown`, an older
 * widget listens for `mousedown`, and a menu that follows the pointer opens on
 * `mouseover` only.
 */
const CLICK_SEQUENCE = [
  "pointerover",
  "mouseover",
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
] as const;

const HOVER_SEQUENCE = ["pointerover", "mouseover"] as const;

const INDICATORS: Readonly<Record<HintMode, string>> = {
  "activate": "Hints",
  "activate-new-tab": "Hints: new tab",
  "activate-new-tab-background": "Hints: background tab",
  "hover": "Hints: hover",
  "focus": "Hints: focus",
  "copy-link-url": "Hints: copy URL",
  "copy-link-text": "Hints: copy text",
  "open-with-omnibar": "Hints: omnibar",
  "download": "Hints: download",
};

/** The modes that write the clipboard, and that therefore need a true gesture. */
const COPY_MODES: ReadonlySet<HintMode> = new Set<HintMode>([
  "copy-link-url",
  "copy-link-text",
]);

/** The modes that can act only on something that has a URL. */
export const modeRequiresHref = (mode: HintMode): boolean =>
  mode === "activate-new-tab" || mode === "activate-new-tab-background" ||
  mode === "copy-link-url" || mode === "open-with-omnibar" ||
  mode === "download";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The wire carries a plain string.
 *
 * `FrameId` is a brand, which exists at compile time only, so this changes no
 * value. The bus already checked that a frame speaks for itself.
 */
const asFrameId = (value: string): FrameId => value as FrameId;

/** `"a"` gives `"a"`, `"<space>"` gives `" "`, and `"<c-a>"` gives nothing. */
const printableChar = (notation: string): Option.Option<string> => {
  if (notation === "<space>") return Option.some(" ");
  // A key notation is one Unicode code point, or a token inside brackets.
  // oxlint-disable-next-line typescript/no-misused-spread
  return [...notation].length === 1 ? Option.some(notation) : Option.none();
};

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
const descriptorsFor = (
  frameId: FrameId,
  hints: readonly LocalHint[],
): readonly HintDescriptor[] =>
  hints.slice(0, MAX_WIRE_DESCRIPTORS).map((hint, localIndex) => ({
    frameId,
    localIndex,
    // Cut to the bound of the wire. A longer value makes the whole message
    // fail the schema of the receiver, and that frame would lose every hint.
    linkText: hint.linkText.slice(0, MAX_WIRE_LINK_TEXT),
    secondary: hint.secondary,
  }));

/** Where an activation came from. A remote one has no gesture of the user. */
export type ActivationOrigin = "local" | "remote";

type SessionRole = "origin" | "participant";

interface SessionConfig {
  readonly mode: HintMode;
  readonly entries: readonly HintEntry[];
  readonly role: SessionRole;
  /** Send each keystroke to the other frames, so they stay in step. */
  readonly crossFrame: boolean;
  /** The frame that drives this session, when this frame does not. */
  readonly driver: Option.Option<FrameId>;
  /** The keys that arrived while the round was collected. */
  readonly replay: readonly string[];
}

interface SessionState {
  /** The queue of keystrokes in alphabet mode. */
  readonly typed: string;
  /** The queue of keystrokes for the link text in filter mode. */
  readonly text: string;
  /** The queue of digit keystrokes in filter mode. */
  readonly digits: string;
  readonly activeIndex: number;
  readonly outcome: FilterOutcome;
}

/** The live session, as the message handlers of this service see it. */
interface LiveSession {
  readonly id: number;
  readonly mode: HintMode;
  readonly role: SessionRole;
  readonly driver: Option.Option<FrameId>;
  readonly key: (notation: string) => Effect.Effect<void>;
}

/** What this frame remembers about the round that it answered. */
interface LocalRound {
  readonly mode: HintMode;
  readonly openedAt: number;
  /** The frame that drives the round. It is known from the `ACTIVATE`. */
  readonly origin: Option.Option<FrameId>;
}

/** What the top frame remembers about the one live round of the page. */
interface TopRound {
  readonly origin: FrameId;
  readonly mode: HintMode;
  readonly startedAt: number;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Hints extends Context.Service<Hints, {
  /** Start a hint round in this frame. A second call replaces the first. */
  readonly activate: (mode: HintMode) => Effect.Effect<void>;
  readonly isActive: Effect.Effect<boolean>;
  readonly deactivate: Effect.Effect<void>;
}>()("vimium/features/hints/Hints") {
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
    Effect.gen(function*() {
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
      const topRoundRef = yield* Ref.make(Option.none<TopRound>());
      const sessionRef = yield* Ref.make(Option.none<LiveSession>());
      const sessionSeq = yield* Ref.make(0);
      /** True while a round is collected, before its session exists. */
      const startingRef = yield* Ref.make(false);
      /** One session at a time. A new one interrupts the one before it. */
      const sessionFiber = yield* FiberHandle.make<void, never>();

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
        button: 0,
        buttons: 1,
      });

      const dispatchPointerish = (
        element: Element,
        type: string,
        init: MouseEventInit,
      ): void => {
        const isPointer = type.startsWith("pointer");
        const event = isPointer && typeof PointerEvent === "function"
          ? new PointerEvent(type, {
            ...init,
            pointerType: "mouse",
            isPrimary: true,
          })
          : new MouseEvent(type, init);
        element.dispatchEvent(event);
      };

      const centreOf = (element: Element): { x: number; y: number } => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      };

      /**
       * Focus before the click, and record the hover target.
       *
       * Some click handlers read the focused element. The record lets a later
       * Escape undo the hover.
       */
      const prepare = (element: Element): Effect.Effect<void> =>
        Effect.andThen(
          Effect.ignore(dom.attempt("Element.focus", () => {
            const name = element.localName;
            if (
              name !== "input" && name !== "select" && name !== "object" &&
              name !== "embed"
            ) return;
            if (
              element instanceof HTMLElement || element instanceof SVGElement
            ) {
              element.focus({ preventScroll: true });
            }
          })),
          Ref.set(hoverRef, Option.some(new WeakRef(element))),
        );

      /**
       * Send one sequence of pointer events.
       *
       * The whole sequence is inside one `attempt`, because a listener of the
       * page runs inside `dispatchEvent`, and a listener of the page can throw.
       * A throw of the page must not become a defect of ours.
       */
      const dispatchSequence = (
        element: Element,
        types: readonly string[],
      ): Effect.Effect<void> =>
        Effect.gen(function*() {
          yield* prepare(element);
          const { x, y } = yield* dom.probeOr(
            () => centreOf(element),
            { x: 0, y: 0 },
          );
          const init = eventInit(x, y);
          yield* Effect.ignore(dom.attempt("Element.dispatchEvent", () => {
            for (const type of types) {
              dispatchPointerish(element, type, init);
            }
          }));
        });

      const simulateClick = (element: Element): Effect.Effect<void> =>
        dispatchSequence(element, CLICK_SEQUENCE);

      const simulateHover = (element: Element): Effect.Effect<void> =>
        dispatchSequence(element, HOVER_SEQUENCE);

      /**
       * Undo the last hover.
       *
       * Without this, an Escape after a hover over a navigation item leaves the
       * large menu of the site open, because the page never saw a `mouseout`.
       */
      const releaseHover: Effect.Effect<void> = Effect.gen(function*() {
        const held = yield* Ref.getAndSet(hoverRef, Option.none());
        if (Option.isNone(held)) return;
        const element = held.value.deref();
        if (element === undefined || !element.isConnected) return;
        const { x, y } = yield* dom.probeOr(
          () => centreOf(element),
          { x: 0, y: 0 },
        );
        const init = { ...eventInit(x, y), buttons: 0 };
        yield* Effect.ignore(dom.attempt("Element.dispatchEvent", () => {
          dispatchPointerish(element, "pointerout", init);
          dispatchPointerish(element, "mouseout", init);
        }));
      });

      const openInNewTab = Effect.fn("Hints.openInNewTab")(
        function*(url: string, active: boolean) {
          const outcome = yield* Effect.result(tabs.open(url, { active }));
          if (Result.isFailure(outcome)) {
            yield* report.error(outcome.failure.detail);
            return;
          }
          if (!outcome.success.viaManager && !active) {
            // `window.open` cannot put a tab in the background. Say so, instead
            // of letting the user believe that the setting was honoured.
            yield* hud.show(
              "Opened in the foreground: there is no GM.openInTab.",
            );
          }
        },
      );

      /**
       * Write text to the clipboard.
       *
       * The first attempt inside `Clipboard.write` does not suspend, so the
       * write still happens inside the activation window of WebKit, as long as
       * nothing in front of this call suspends.
       */
      const copy = Effect.fn("Hints.copy")(
        function*(text: string, label: string) {
          const outcome = yield* Effect.result(clipboard.write(text));
          if (Result.isFailure(outcome)) {
            yield* report.error(`Copy failed: ${outcome.failure.detail}`);
            return;
          }
          yield* hud.show(`Copied ${label}`);
        },
      );

      /**
       * Act on a hint that belongs to *this* frame.
       *
       * `origin` exists because a remote activation is an action that another
       * document asked for, and two of the modes here are capabilities that a
       * page must not spend for the user.
       */
      const activateLocal = Effect.fn("Hints.activateLocal")(
        function*(
          hint: LocalHint,
          mode: HintMode,
          origin: ActivationOrigin,
        ) {
          const element = hint.element;

          // Depth behind the round check. The reasoning that used to stand here
          // — that a remote copy runs outside a key task and is refused — is
          // wrong: the clipboard falls back to the manager, which needs no
          // activation at all. A clipboard write with no sign, and with
          // contents that an attacker chose, is a known phishing primitive.
          if (origin === "remote" && COPY_MODES.has(mode)) {
            yield* report.error(
              "Ignored a clipboard request from another frame.",
            );
            return;
          }

          switch (mode) {
            case "activate":
              yield* simulateClick(element);
              return;

            case "activate-new-tab":
            case "activate-new-tab-background": {
              if (Option.isNone(hint.href)) {
                // There is nothing to give to `Tabs.open`, and a synthetic
                // modifier-click would be a plain click. Do the honest thing,
                // and say what happened.
                yield* simulateClick(element);
                yield* hud.show("No link URL: activated in this tab.");
                return;
              }
              yield* openInNewTab(hint.href.value, mode === "activate-new-tab");
              return;
            }

            case "hover":
              yield* simulateHover(element);
              return;

            case "focus":
              yield* Effect.ignore(dom.attempt("Element.focus", () => {
                if (
                  element instanceof HTMLElement ||
                  element instanceof SVGElement
                ) {
                  element.focus({ preventScroll: true });
                }
              }));
              return;

            case "copy-link-url":
              if (Option.isNone(hint.href)) {
                yield* report.error("That hint has no URL to copy.");
                return;
              }
              yield* copy(hint.href.value, hint.href.value);
              return;

            case "copy-link-text":
              yield* copy(hint.linkText, "link text");
              return;

            case "open-with-omnibar":
              // The omnibar takes no initial query, so the URL cannot be filled
              // in. To show it keeps the command useful instead of confusing.
              if (Option.isSome(hint.href)) yield* hud.show(hint.href.value);
              // Through the registry, and not through an import: a feature must
              // not depend on another feature. A build without the omnibar
              // answers "unavailable", and the user reads why.
              yield* Effect.catch(
                commands.run("Vomnibar.activate", {
                  count: 1,
                  options: {},
                  event: null,
                }),
                (error) => report.error(error.detail),
              );
              return;

            case "download":
              // Tier C. Upstream does this with a synthetic Alt-click, which
              // WebKit does not route to the download path for an untrusted
              // event.
              yield* report.error(
                "Download-link hints are not possible in a userscript on " +
                  "WebKit: a synthetic Alt-click is untrusted, and it never " +
                  "reaches the download path. Use the context menu " +
                  "(Control-click, then Download Linked File).",
              );
              return;
          }
        },
      );

      // ---------------------------------------------------------------------
      // Styles and detection
      // ---------------------------------------------------------------------

      const ensureStyles = Effect.gen(function*() {
        const current = yield* settings.current;
        const css = hintCss(current.userDefinedLinkHintCss);
        const installed = yield* Ref.get(cssRef);
        if (Option.isSome(installed) && installed.value === css) return;
        // CSSOM only. A `<style>` element here obeys the `style-src` of the
        // page, and it is dropped in silence on a site with a strict policy.
        // Keyed, and not appended: the user CSS can change, and every earlier
        // version would otherwise stay in effect beside the current one.
        yield* ui.setStyle("hints", css);
        yield* Ref.set(cssRef, Option.some(css));
      });

      const detectLocal = Effect.fn("Hints.detect")(function*(mode: HintMode) {
        const viewport = yield* ui.viewport;
        const result = yield* Effect.provideContext(
          detectHints({
            window: dom.window,
            document: dom.document,
            capabilities,
            viewport,
            requireHref: modeRequiresHref(mode),
            overlayHost: Option.some(ui.shadow.host),
          }),
          browser,
        );

        if (result.unreachableHosts > 0 && !(yield* Ref.get(warnedRef))) {
          yield* Ref.set(warnedRef, true);
          // A closed shadow root gives `null` from `element.shadowRoot` by
          // design, and a patch of `attachShadow` needs a reliable
          // `document-start` that WebKit does not give a userscript. To tell
          // the user is better than a silent gap.
          yield* hud.show(
            "Some elements on this page cannot be reached (closed shadow DOM).",
          );
        }

        yield* Ref.set(localRef, result.hints);
        return result.hints;
      });

      /** Merge our own hints with those of the other frames, in one order. */
      const merge = (
        local: readonly LocalHint[],
        remote: readonly HintDescriptor[],
      ): readonly HintEntry[] => {
        const own = descriptorsFor(bus.frameId, local);
        // Drop any echo of our own descriptors. Upstream measured the removal
        // of them from each reply as a large gain, and we must not count them
        // two times.
        const others = remote.filter(
          (descriptor) => descriptor.frameId !== bus.frameId,
        );
        return sortDescriptors([...own, ...others]).map((descriptor) => ({
          frameId: asFrameId(descriptor.frameId),
          localIndex: descriptor.localIndex,
          linkText: descriptor.linkText,
          secondary: descriptor.secondary,
          hint: descriptor.frameId === bus.frameId
            ? Option.fromNullishOr(local[descriptor.localIndex])
            : Option.none(),
        }));
      };

      // ---------------------------------------------------------------------
      // The session
      // ---------------------------------------------------------------------

      const runSession = (
        config: SessionConfig,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function*() {
          const current = yield* settings.current;
          const filtering = current.filterLinkHints;
          const waitForEnter = current.waitForEnterForFilteredHints;
          const ignoreLayout = current.ignoreKeyboardLayout;
          const keyContext: KeyContext = {
            ignoreKeyboardLayout: ignoreLayout,
            applePlatform: capabilities.applePlatform,
          };
          const alphabet = normaliseHintCharacters(
            current.linkHintCharacters,
            DEFAULT_HINT_CHARACTERS,
          );
          const numbers = normaliseHintCharacters(
            current.linkHintNumbers,
            DEFAULT_HINT_NUMBERS,
          );
          const isOrigin = config.role === "origin";

          /** The positions of `entries` that this frame owns, in order. */
          const localPositions = config.entries
            .map((entry, index) => (Option.isNone(entry.hint) ? -1 : index))
            .filter((index) => index >= 0);

          const hintList = filtering
            ? []
            : hintStrings(config.entries.length, alphabet);

          const candidates: readonly FilterCandidate[] = config.entries.map((
            entry,
            index,
          ) => ({
            index,
            linkText: entry.linkText,
            secondary: entry.secondary,
          }));

          const query = (state: SessionState): string =>
            `${state.text}${state.digits}`.trim();

          const filterFor = (state: SessionState): FilterOutcome =>
            filterHints(candidates, {
              text: state.text,
              digits: state.digits,
              numberCharacters: numbers,
            });

          const initial: SessionState = {
            typed: "",
            text: "",
            digits: "",
            activeIndex: 0,
            outcome: filterHints(candidates, {
              text: "",
              digits: "",
              numberCharacters: numbers,
            }),
          };
          const state = yield* Ref.make(initial);

          const markers = yield* Effect.provideContext(
            makeMarkerLayer,
            browser,
          );
          const done = yield* Deferred.make<void>();
          const confirm = yield* FiberHandle.make<void, never>();

          /**
           * Take away the confirmation that waits.
           *
           * `FiberHandle.run` with an effect that does nothing, and not
           * `FiberHandle.clear`. `clear` waits for the interruption of the
           * fiber, and this runs inside a `keydown`, where nothing may
           * suspend. `run` replaces the fiber and does not wait.
           */
          const cancelConfirm: Effect.Effect<void> = Effect.asVoid(
            FiberHandle.run(confirm, Effect.void),
          );
          const handleRef = yield* Ref.make(Option.none<ModeHandle>());
          const id = yield* Ref.modify(sessionSeq, (n) => [n, n + 1]);

          const exitSession = (reason: ExitReason): Effect.Effect<void> =>
            Effect.flatMap(Ref.get(handleRef), (handle) =>
              Option.isSome(handle)
                ? handle.value.exit(reason)
                : Effect.asVoid(Deferred.succeed(done, undefined)));

          const isLive: Effect.Effect<boolean> = Effect.flatMap(
            Ref.get(handleRef),
            (handle) =>
              Option.isNone(handle)
                ? Effect.succeed(false)
                : handle.value.isActive,
          );

          // -- rendering ---------------------------------------------------

          const alphabetSpecs = (
            snapshot: SessionState,
          ): readonly MarkerSpec[] => {
            const specs: MarkerSpec[] = [];
            for (const position of localPositions) {
              const entry = config.entries[position];
              if (entry === undefined || Option.isNone(entry.hint)) continue;
              const hint = entry.hint.value;
              const hintString = hintList[position] ?? "";
              specs.push({
                rect: hint.rect,
                hintString,
                matchedLength: snapshot.typed.length,
                secondary: entry.secondary,
                active: false,
                linkText: hint.linkText,
                showLinkText: false,
                hidden: !hintString.startsWith(snapshot.typed),
              });
            }
            return specs;
          };

          const filterSpecs = (
            snapshot: SessionState,
          ): readonly MarkerSpec[] => {
            const numbering = new Map<number, FilterMatch>();
            for (const match of snapshot.outcome.matched) {
              numbering.set(match.index, match);
            }
            const visible = new Set(
              snapshot.outcome.candidates.map((match) => match.index),
            );
            const activeIndex = snapshot.outcome
              .candidates[snapshot.activeIndex]?.index;

            const specs: MarkerSpec[] = [];
            for (const position of localPositions) {
              const entry = config.entries[position];
              if (entry === undefined || Option.isNone(entry.hint)) continue;
              const hint = entry.hint.value;
              const match = numbering.get(position);
              const hintString = match?.hintString ?? "";
              specs.push({
                rect: hint.rect,
                hintString,
                matchedLength: matchedPrefixLength(hintString, snapshot.digits),
                secondary: entry.secondary,
                active: position === activeIndex,
                linkText: hint.linkText,
                showLinkText: hint.showLinkText,
                hidden: match === undefined || !visible.has(position),
              });
            }
            return specs;
          };

          const render: Effect.Effect<void> = Effect.flatMap(
            Ref.get(state),
            (snapshot) =>
              markers.render(
                filtering ? filterSpecs(snapshot) : alphabetSpecs(snapshot),
              ),
          );

          // -- activation --------------------------------------------------

          const activateIndex = (index: number): Effect.Effect<void> =>
            Effect.gen(function*() {
              const entry = config.entries[index];
              if (entry === undefined) return;

              // The overlay goes first: activation can move the focus, and a
              // marker that is still drawn would be visible for one frame after
              // a navigation starts.
              yield* exitSession("explicit");

              // A participant draws and follows, and the origin is the frame
              // that acts. It acts here, or it addresses the frame that owns
              // the entry, which can be this frame as well.
              if (!isOrigin) return;

              if (Option.isSome(entry.hint)) {
                // Detached and started at once, so that the clipboard write of
                // a copy mode still happens inside the activation window, and
                // so that a mode which must wait does not suspend the key path.
                yield* Effect.forkDetach(
                  activateLocal(entry.hint.value, config.mode, "local"),
                  { startImmediately: true },
                );
                return;
              }

              yield* Effect.ignore(bus.send(toFrame(entry.frameId), {
                kind: "ACTIVATE_HINT",
                localIndex: entry.localIndex,
                mode: config.mode,
              }));
            });

          const activateActive: Effect.Effect<void> = Effect.gen(function*() {
            const snapshot = yield* Ref.get(state);
            const match = snapshot.outcome.candidates[snapshot.activeIndex];
            if (match === undefined) return;
            yield* activateIndex(match.index);
          });

          // -- matching ----------------------------------------------------

          const update: Effect.Effect<void> = Effect.gen(function*() {
            yield* cancelConfirm;
            const snapshot = yield* Ref.get(state);

            if (!filtering) {
              const matches = matchByPrefix(hintList, snapshot.typed);
              if (matches.length === 0) {
                // Only the origin speaks: one HUD message for the page, and not
                // one for each frame that runs the same round.
                if (isOrigin) yield* hud.show("No matching hint", 800);
                yield* exitSession("explicit");
                return;
              }
              const only = matches.length === 1 ? matches[0] : undefined;
              if (only !== undefined && hintList[only] === snapshot.typed) {
                yield* activateIndex(only);
                return;
              }
              yield* render;
              return;
            }

            const outcome = filterFor(snapshot);
            const next: SessionState = {
              ...snapshot,
              outcome,
              activeIndex: 0,
            };
            yield* Ref.set(state, next);
            yield* render;

            if (outcome.candidates.length === 0) {
              if (isOrigin) {
                yield* hud.show(`No matches for "${query(next)}"`);
              }
              return;
            }
            if (isOrigin && query(next).length > 0) {
              yield* hud.show(query(next));
            }

            const exact = outcome.exact;
            if (Option.isNone(exact) || outcome.candidates.length !== 1) return;

            if (!waitForEnter) {
              yield* activateIndex(exact.value.index);
              return;
            }
            // Confirmation: Enter activates at once, and so does a pause in the
            // typing. The pause matters, because filter mode narrows to one
            // match long before the user has finished the word.
            yield* Effect.asVoid(FiberHandle.run(
              confirm,
              Effect.andThen(
                Effect.sleep(FILTER_CONFIRM_DELAY_MS),
                activateIndex(exact.value.index),
              ),
            ));
          });

          // -- input -------------------------------------------------------

          const appendChar = (char: string): Effect.Effect<void> =>
            Effect.gen(function*() {
              if (filtering) {
                yield* Ref.update(state, (snapshot) =>
                  numbers.includes(char)
                    ? { ...snapshot, digits: snapshot.digits + char }
                    : { ...snapshot, text: snapshot.text + char });
                yield* update;
                return;
              }
              const lower = char.toLowerCase();
              if (!alphabet.includes(lower)) return;
              yield* Ref.update(state, (snapshot) => ({
                ...snapshot,
                typed: snapshot.typed + lower,
              }));
              yield* update;
            });

          const backspace: Effect.Effect<void> = Effect.gen(function*() {
            const snapshot = yield* Ref.get(state);
            if (filtering) {
              if (snapshot.digits.length > 0) {
                yield* Ref.set(state, {
                  ...snapshot,
                  digits: snapshot.digits.slice(0, -1),
                });
              } else if (snapshot.text.length > 0) {
                yield* Ref.set(state, {
                  ...snapshot,
                  text: snapshot.text.slice(0, -1),
                });
              } else {
                yield* exitSession("escape");
                return;
              }
              yield* update;
              return;
            }

            if (snapshot.typed.length === 0) {
              yield* exitSession("escape");
              return;
            }
            yield* Ref.set(state, {
              ...snapshot,
              typed: snapshot.typed.slice(0, -1),
            });
            yield* update;
          });

          const cycle = (direction: 1 | -1): Effect.Effect<void> =>
            Effect.gen(function*() {
              const snapshot = yield* Ref.get(state);
              const count = snapshot.outcome.candidates.length;
              if (count === 0) return;
              yield* Ref.set(state, {
                ...snapshot,
                activeIndex: (snapshot.activeIndex + direction + count) % count,
              });
              // Tab is an explicit "not that one". Take away any activation
              // that waits.
              yield* cancelConfirm;
              yield* render;
            });

          const handleKey = (notation: string): Effect.Effect<void> =>
            Effect.gen(function*() {
              if (!(yield* isLive)) return;

              if (notation === "<esc>") {
                yield* exitSession("escape");
                return;
              }
              if (notation === "<backspace>" || notation === "<delete>") {
                yield* backspace;
                return;
              }

              if (filtering) {
                if (notation === "<enter>") {
                  yield* activateActive;
                  return;
                }
                if (notation === "<tab>") {
                  yield* cycle(1);
                  return;
                }
                if (notation === "<s-tab>") {
                  yield* cycle(-1);
                  return;
                }
              }

              const char = printableChar(notation);
              if (Option.isNone(char)) return;
              yield* appendChar(char.value);
            });

          const relay = (notation: string): Effect.Effect<void> =>
            config.crossFrame
              ? Effect.ignore(bus.broadcast({ kind: "KEYSTROKE", notation }))
              : Effect.void;

          const onKeydown = (
            event: KeyboardEvent,
          ): Effect.Effect<HandlerResult> =>
            Effect.gen(function*() {
              // A keystroke in the middle of a composition belongs to the input
              // method, and not to us.
              if (isComposing(event)) return SUPPRESS_EVENT;
              const notation = keyNotation(event, keyContext);
              if (Option.isNone(notation)) {
                return SUPPRESS_EVENT;
              }
              const key = notation.value;

              // Escape tears the origin session down. Relay it first, while the
              // round is still live, so that a participant removes its markers
              // as well. An activation key stays local first, because a copy
              // mode needs the activation of this keystroke.
              if (key === "<esc>") yield* relay(key);
              yield* handleKey(key);
              if (key !== "<esc>") yield* relay(key);
              return SUPPRESS_EVENT;
            });

          // -- the mode ----------------------------------------------------

          const handle = yield* modes.enter({
            name: "hints",
            indicator: INDICATORS[config.mode],
            // Hint mode handles Escape itself, because the origin must relay it
            // before the teardown. The generic exit would run first.
            exitOnEscape: false,
            // Hint mode owns the keyboard: a key that we do not use must not
            // reach the page, or `j` scrolls while the user picks a link.
            suppressAllKeyboardEvents: true,
            singleton: "hints",
          }, { keydown: onKeydown });

          yield* Ref.set(handleRef, Option.some(handle));

          yield* handle.onExit((reason) =>
            Effect.gen(function*() {
              yield* cancelConfirm;
              yield* markers.clear;
              // Escape means "undo what I was pointing at". An explicit
              // activation means that the hover was wanted, and it must stay.
              if (reason === "escape") yield* releaseHover;
              yield* Effect.asVoid(Deferred.succeed(done, undefined));
            })
          );

          const session: LiveSession = {
            id,
            mode: config.mode,
            role: config.role,
            driver: config.driver,
            key: handleKey,
          };

          // The HUD goes here, and not in the exit body of the mode. `Hud.hide`
          // waits for the timer fiber of the message before it, and the exit
          // body of the mode runs inside a `keydown`, where nothing may
          // suspend. A finaliser runs in the fiber of the session.
          yield* Effect.addFinalizer(() => hud.hide);

          yield* Effect.acquireRelease(
            Ref.set(sessionRef, Option.some(session)),
            () =>
              Ref.update(sessionRef, (live) =>
                Option.isSome(live) && live.value.id === id
                  ? Option.none()
                  : live),
          );

          // The top frame holds the record of the one live round. When this
          // frame is both the top frame and the origin, no `KEYSTROKE` comes
          // back to it, so the record is cleared here instead.
          yield* Effect.addFinalizer(() =>
            bus.isTop && isOrigin
              ? Ref.update(topRoundRef, (live) =>
                Option.isSome(live) && live.value.origin === bus.frameId
                  ? Option.none()
                  : live)
              : Effect.void
          );

          yield* render;

          for (const notation of config.replay) {
            if (!(yield* isLive)) {
              break;
            }
            yield* handleKey(notation);
          }

          yield* Deferred.await(done);
        });

      const beginSession = (config: SessionConfig): Effect.Effect<void> =>
        Effect.asVoid(
          FiberHandle.run(sessionFiber, Effect.scoped(runSession(config))),
        );

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
      const bufferKeys = (
        keys: Ref.Ref<readonly string[]>,
        abort: Deferred.Deferred<void>,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function*() {
          const ignoreLayout = (yield* settings.current).ignoreKeyboardLayout;
          const keyContext: KeyContext = {
            ignoreKeyboardLayout: ignoreLayout,
            applePlatform: capabilities.applePlatform,
          };
          const handle = yield* modes.enter({
            name: "hints/buffer",
            exitOnEscape: true,
            suppressAllKeyboardEvents: true,
            singleton: "hints",
          }, {
            keydown: (event) =>
              Effect.gen(function*() {
                const notation = keyNotation(event, keyContext);
                if (Option.isSome(notation) && notation.value !== "<esc>") {
                  yield* Ref.update(keys, (current) => [
                    ...current,
                    notation.value,
                  ]);
                }
                return SUPPRESS_EVENT;
              }),
          });

          yield* handle.onExit((reason) =>
            reason === "escape"
              ? Effect.asVoid(Deferred.succeed(abort, undefined))
              : Effect.void
          );

          yield* Effect.forkScoped(
            Effect.andThen(
              Effect.sleep(KEY_BUFFER_SAFETY_MS),
              handle.exit("explicit"),
            ),
          );
        });

      const readHintsResult = (
        reply: InboundMessage,
      ): Option.Option<readonly HintDescriptor[]> =>
        reply.message.kind === "HINTS_RESULT"
          ? Option.some(reply.message.descriptors)
          : Option.none();

      const collectRemote = Effect.fn("Hints.collectRemote")(
        function*(mode: HintMode) {
          const peers = yield* bus.peers;
          // One frame is this frame. There is nobody to ask.
          if (peers.length <= 1) return [] as readonly HintDescriptor[];
          // Time-boxed, and it swallows the failure: a frame that never answers
          // must degrade to "hints for the frames that did", and not to a dead
          // page.
          return yield* Effect.orElseSucceed(
            bus.request(
              toTop,
              { kind: "REQUEST_HINTS", mode },
              readHintsResult,
              COLLECT_DEADLINE_MS,
            ),
            () => [] as readonly HintDescriptor[],
          );
        },
      );

      const startRound = Effect.fn("Hints.startRound")(function*(
        mode: HintMode,
      ) {
        yield* ensureStyles;

        const buffered = yield* Ref.make<readonly string[]>([]);
        const abort = yield* Deferred.make<void>();

        // The buffer starts at the first moment: detection is chunked, and so
        // it is asynchronous even in one frame, and a fast typist gets ahead of
        // it.
        const collect = Effect.scoped(Effect.gen(function*() {
          yield* Effect.acquireRelease(
            Ref.set(startingRef, true),
            () => Ref.set(startingRef, false),
          );
          yield* bufferKeys(buffered, abort);
          const local = yield* detectLocal(mode);
          const remote = yield* collectRemote(mode);
          return Option.some({ local, remote });
        }));

        // Escape during the collection ends the round. The loser of the race is
        // interrupted, which stops the detection at its next slice.
        const collected = yield* Effect.race(
          collect,
          Effect.as(Deferred.await(abort), Option.none()),
        );
        if (Option.isNone(collected)) return;
        const { local, remote } = collected.value;

        const entries = merge(local, remote);
        if (entries.length === 0) {
          yield* hud.show("No links to select");
          return;
        }

        const keys = yield* Ref.get(buffered);
        // Replay in filter mode only. In alphabet mode the buffered characters
        // were typed against hint strings that did not exist yet, so a replay
        // would activate a link that is as good as random.
        const filtering = (yield* settings.current).filterLinkHints;

        yield* Effect.scoped(runSession({
          mode,
          entries,
          role: "origin",
          crossFrame: remote.length > 0,
          driver: Option.none(),
          replay: filtering ? keys : [],
        }));
      });

      // ---------------------------------------------------------------------
      // The round, as the top frame runs it
      // ---------------------------------------------------------------------

      const readHints = (
        frameId: FrameId,
      ) =>
      (reply: InboundMessage): Option.Option<readonly HintDescriptor[]> => {
        if (reply.message.kind !== "HINTS") return Option.none();
        if (reply.from !== frameId) return Option.none();
        // A frame speaks for itself only. To give a descriptor to the frame
        // that did not produce it breaks the shared order, which is a
        // correctness problem and not only an attack.
        return Option.some(
          reply.message.descriptors.filter(
            (descriptor) => descriptor.frameId === frameId,
          ),
        );
      };

      /**
       * Ask every frame for its descriptors, and give them back in the one
       * order that every frame must agree on.
       *
       * The origin is asked as well, although it has already run its own
       * detection. Without its descriptors the other frames would work out
       * another assignment of the hint strings, and the whole scheme rests on
       * every frame agreeing.
       */
      const collectEveryFrame = Effect.fn("Hints.collectEveryFrame")(
        function*(mode: HintMode) {
          const peers = yield* bus.peers;
          const replies = yield* Effect.forEach(
            peers,
            (frameId) =>
              Effect.orElseSucceed(
                bus.request(
                  toFrame(frameId),
                  { kind: "COLLECT_HINTS", mode },
                  readHints(frameId),
                  REQUEST_DEADLINE,
                ),
                () => [] as readonly HintDescriptor[],
              ),
            { concurrency: "unbounded" },
          );
          return sortDescriptors(replies.flat());
        },
      );

      const runHintRound = Effect.fn("Hints.runHintRound")(
        function*(origin: FrameId, mode: HintMode) {
          const descriptors = yield* collectEveryFrame(mode);
          const peers = yield* bus.peers;

          // Every frame except the origin learns that a session is live, and
          // draws its own markers. Each copy has the descriptors of its
          // receiver removed, because the receiver works them out again from
          // the local hints that it already holds.
          yield* Effect.forEach(
            peers.filter((frameId) => frameId !== origin),
            (frameId) =>
              Effect.ignore(bus.send(toFrame(frameId), {
                kind: "ACTIVATE",
                originFrameId: origin,
                mode,
                descriptors: descriptors.filter(
                  (descriptor) => descriptor.frameId !== frameId,
                ),
              })),
            { discard: true },
          );

          // The origin gets the same treatment. Upstream measured the removal
          // of its own descriptors as a large gain on a page with many links,
          // and it is the reason that the heavy `LocalHint` never crosses a
          // frame boundary.
          return descriptors.filter(
            (descriptor) => descriptor.frameId !== origin,
          );
        },
      );

      // ---------------------------------------------------------------------
      // The messages that this service answers
      // ---------------------------------------------------------------------

      /** What a handler of `FrameBus.serve` gives back. */
      type ServeResult = Effect.Effect<Option.Option<FrameMessage>>;

      const onRequestHints = (message: InboundMessage): ServeResult =>
        Effect.gen(function*() {
          if (message.message.kind !== "REQUEST_HINTS") return Option.none();
          const mode = message.message.mode;
          const now = yield* dom.now;
          const live = yield* Ref.get(topRoundRef);

          // One live round for the whole page. An admitted frame could
          // otherwise start detection passes without a limit. The frame that
          // owns the live round may replace it, because a frame that asks again
          // has left the round that it had.
          if (
            Option.isSome(live) &&
            now - live.value.startedAt <= ROUND_TTL_MS &&
            live.value.origin !== message.from
          ) return Option.none();

          yield* Ref.set(
            topRoundRef,
            Option.some({ origin: message.from, mode, startedAt: now }),
          );

          const descriptors = yield* runHintRound(message.from, mode);
          return Option.some({
            kind: "HINTS_RESULT" as const,
            descriptors,
          });
        });

      const onCollectHints = (message: InboundMessage): ServeResult =>
        Effect.gen(function*() {
          if (message.message.kind !== "COLLECT_HINTS") return Option.none();
          const mode = message.message.mode;
          const hints = yield* detectLocal(mode);
          const now = yield* dom.now;
          // The round of this frame opens here, and its age is bounded. It is
          // bounded by time and not by "a mode is live", because the origin
          // frame tears its own mode down before it acts.
          yield* Ref.set(
            roundRef,
            Option.some({ mode, openedAt: now, origin: Option.none() }),
          );
          return Option.some({
            kind: "HINTS" as const,
            descriptors: descriptorsFor(bus.frameId, hints),
          });
        });

      const onActivate = (message: InboundMessage): ServeResult =>
        Effect.gen(function*() {
          if (message.message.kind !== "ACTIVATE") return Option.none();
          const payload = message.message;

          // We would be the origin of this round. The origin drives its own
          // session, and it never joins as a participant.
          if (payload.originFrameId === bus.frameId) return Option.none();

          const round = yield* Ref.get(roundRef);
          const now = yield* dom.now;
          // A round exists in this frame only after we answered a
          // `COLLECT_HINTS`. Anything else is not a round that we take part in.
          if (
            Option.isNone(round) ||
            now - round.value.openedAt > ROUND_TTL_MS ||
            round.value.mode !== payload.mode
          ) return Option.none();

          const origin = asFrameId(payload.originFrameId);
          yield* Ref.set(
            roundRef,
            Option.some({ ...round.value, origin: Option.some(origin) }),
          );

          yield* ensureStyles;
          const local = yield* Ref.get(localRef);
          // `local` is the answer of this frame to the `COLLECT_HINTS` that
          // opened the round, and the descriptors arrive with our own entries
          // removed, so `merge` builds exactly the order that the origin
          // worked out.
          const entries = merge(local, payload.descriptors);
          if (entries.length === 0) return Option.none();

          yield* beginSession({
            mode: payload.mode,
            entries,
            role: "participant",
            // A key reaches us over the relay. To send it back would loop.
            crossFrame: false,
            driver: Option.some(origin),
            replay: [],
          });
          return Option.none();
        });

      const onActivateHint = (message: InboundMessage): ServeResult =>
        Effect.gen(function*() {
          if (message.message.kind !== "ACTIVATE_HINT") return Option.none();
          const payload = message.message;

          const round = yield* Ref.get(roundRef);
          const now = yield* dom.now;
          if (Option.isNone(round)) return Option.none();
          if (now - round.value.openedAt > ROUND_TTL_MS) {
            yield* Ref.set(roundRef, Option.none());
            return Option.none();
          }
          // Only the frame that owns the live round may drive it. This message
          // ends in a click, a hover, a focus or a clipboard write inside a
          // document of another origin.
          if (
            Option.isNone(round.value.origin) ||
            round.value.origin.value !== message.from ||
            round.value.mode !== payload.mode
          ) return Option.none();

          const hints = yield* Ref.get(localRef);
          const hint = hints[payload.localIndex];
          if (hint === undefined) return Option.none();

          // One activation for each round, so that one authorised request
          // cannot be replayed into a click on every element that this frame
          // ever hinted.
          yield* Ref.set(roundRef, Option.none());
          yield* activateLocal(hint, payload.mode, "remote");
          return Option.none();
        });

      const onKeystroke = (message: InboundMessage): ServeResult =>
        Effect.gen(function*() {
          if (message.message.kind !== "KEYSTROKE") return Option.none();
          const notation = message.message.notation;

          if (bus.isTop && notation === "<esc>") {
            // The round of the page ends when the frame that owns it leaves.
            yield* Ref.update(
              topRoundRef,
              (live) =>
                Option.isSome(live) && live.value.origin === message.from
                  ? Option.none()
                  : live,
            );
          }

          const live = yield* Ref.get(sessionRef);
          if (Option.isNone(live)) return Option.none();
          const session = live.value;
          // A keystroke means something inside a round only, and only from the
          // frame that the user types into.
          if (session.role !== "participant") return Option.none();
          if (
            Option.isNone(session.driver) ||
            session.driver.value !== message.from
          ) return Option.none();

          yield* session.key(notation);
          return Option.none();
        });

      if (bus.isTop) {
        // The top frame is the broker of the round. A child frame asks it, and
        // it fans the request out to every frame.
        yield* bus.serve("REQUEST_HINTS", onRequestHints);
      }
      yield* bus.serve("COLLECT_HINTS", onCollectHints);
      yield* bus.serve("ACTIVATE", onActivate);
      yield* bus.serve("ACTIVATE_HINT", onActivateHint);
      yield* bus.serve("KEYSTROKE", onKeystroke);

      // ---------------------------------------------------------------------
      // The interface
      // ---------------------------------------------------------------------

      const isActive: Effect.Effect<boolean> = Effect.gen(function*() {
        if (yield* Ref.get(startingRef)) return true;
        return Option.isSome(yield* Ref.get(sessionRef));
      });

      const deactivate: Effect.Effect<void> = Effect.gen(function*() {
        const live = yield* Ref.get(sessionRef);
        const starting = yield* Ref.get(startingRef);
        yield* FiberHandle.clear(sessionFiber);
        if (Option.isSome(live) || starting) yield* releaseHover;
      });

      const service = Hints.of({
        activate: (mode) =>
          Effect.asVoid(FiberHandle.run(sessionFiber, startRound(mode))),
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
        "LinkHints.activateModeToCopyLinkUrl": () =>
          service.activate("copy-link-url"),
        "LinkHints.activateModeToCopyLinkText": () =>
          service.activate("copy-link-text"),
        "LinkHints.activateModeWithOmnibar": () =>
          service.activate("open-with-omnibar"),
      });

      return service;
    }),
  );
}
