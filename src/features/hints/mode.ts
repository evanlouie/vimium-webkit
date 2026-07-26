/**
 * Hint mode: key handling and activation.
 *
 * Ported from Vimium's `content_scripts/link_hints.js` (`LinkHintsMode`,
 * `AlphabetHints`, `FilterHints`, `simulateClick`), MIT.
 *
 * The WebKit-specific parts are all in activation. Two of them matter enough to
 * state up front:
 *
 * - **A synthetic ⌘/Ctrl-click does not open a new tab.** Untrusted events
 *   never reach the browser's own activation path, so the modifier is simply
 *   ignored and the click happens in the current tab — a silent wrong action,
 *   the worst kind. New-tab modes therefore read the `href` and go through
 *   `openTab()`.
 * - **Clipboard writes must be reached synchronously from the `keydown` task.**
 *   Nothing on the activation path may `await` before `writeClipboard()`, or
 *   Safari's transient activation is already spent.
 */

import type {
  AppContext,
  FrameId,
  HintMode as HintModeKind,
} from "~/core/context.ts";
import {
  type Handler,
  type HandlerResult,
  SUPPRESS_EVENT,
} from "~/core/handler-stack.ts";
import { keyNotation } from "~/core/key-notation.ts";
import { Mode } from "~/core/mode.ts";
import { writeClipboard } from "~/platform/clipboard.ts";
import { openTab } from "~/platform/tabs.ts";
import type { LocalHint } from "./detect.ts";
import {
  type FilterCandidate,
  filterHints,
  type FilterMatch,
  type FilterOutcome,
} from "./filter.ts";
import {
  hintStrings,
  matchByPrefix,
  normaliseHintCharacters,
} from "./hint-strings.ts";
import { MarkerLayer, type MarkerSpec } from "./markers.ts";

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * The full event sequence a real click produces.
 *
 * Partial sequences are why "the hint did nothing" bug reports exist: React's
 * synthetic-event bridge listens for `pointerdown`, older widgets listen for
 * `mousedown`, and hover-driven menus only open on `mouseover`.
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

/**
 * The element we last pointed at.
 *
 * A `WeakRef` because the page may remove it at any time and holding a strong
 * reference to an arbitrary DOM node for the lifetime of the session is a leak
 * on infinite-scroll pages.
 */
let lastHovered: WeakRef<Element> | null = null;

const eventInit = (x: number, y: number): MouseEventInit => ({
  bubbles: true,
  cancelable: true,
  composed: true,
  // `document.defaultView` rather than `globalThis`: the initialiser wants a
  // real `Window`, and this is the one the event will actually be seen in.
  view: document.defaultView,
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
    ? new PointerEvent(type, { ...init, pointerType: "mouse", isPrimary: true })
    : new MouseEvent(type, init);
  element.dispatchEvent(event);
};

const centreOf = (element: Element): { x: number; y: number } => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

/**
 * Focus before clicking for elements whose click handler reads the focused
 * element, and record the hover target so a later Escape can undo it.
 */
const prepare = (element: Element): void => {
  const name = element.localName;
  if (
    name === "input" || name === "select" || name === "object" ||
    name === "embed"
  ) {
    if (element instanceof HTMLElement || element instanceof SVGElement) {
      element.focus({ preventScroll: true });
    }
  }
  lastHovered = new WeakRef(element);
};

const simulateClick = (element: Element): void => {
  const { x, y } = centreOf(element);
  const init = eventInit(x, y);
  prepare(element);
  for (const type of CLICK_SEQUENCE) dispatchPointerish(element, type, init);
};

const simulateHover = (element: Element): void => {
  const { x, y } = centreOf(element);
  const init = eventInit(x, y);
  prepare(element);
  for (const type of HOVER_SEQUENCE) dispatchPointerish(element, type, init);
};

/**
 * Undo the last hover.
 *
 * Without this, dismissing hints with Escape after hovering a nav item leaves
 * the site's mega-menu wedged open, because the page never saw a `mouseout`.
 */
export const releaseHover = (): void => {
  const element = lastHovered?.deref();
  lastHovered = null;
  if (element === undefined || !element.isConnected) return;
  const { x, y } = centreOf(element);
  const init = { ...eventInit(x, y), buttons: 0 };
  dispatchPointerish(element, "pointerout", init);
  dispatchPointerish(element, "mouseout", init);
};

/** Modes that can only act on something with a URL. */
export const modeRequiresHref = (kind: HintModeKind): boolean =>
  kind === "activate-new-tab" || kind === "activate-new-tab-background" ||
  kind === "copy-link-url" || kind === "open-with-omnibar" ||
  kind === "download";

const openInNewTab = (
  app: AppContext,
  url: string,
  active: boolean,
): void => {
  void openTab(app.gm, url, { active }).match(
    (outcome) => {
      if (!outcome.viaManager && !active) {
        // `window.open` cannot background a tab; say so rather than letting the
        // user believe the setting was honoured.
        app.hud.show("Opened in the foreground: no GM.openInTab available.");
      }
    },
    (error) => app.hud.error(error.message),
  );
};

/**
 * Where an activation came from.
 *
 * `"remote"` means another frame asked for it, so there is no transient
 * activation to spend and no user gesture in *this* document.
 */
export type ActivationOrigin = "local" | "remote";

/** Modes that write the clipboard, and therefore need a real user gesture. */
const COPY_MODES: ReadonlySet<HintModeKind> = new Set<HintModeKind>([
  "copy-link-url",
  "copy-link-text",
]);

const copy = (app: AppContext, text: string, label: string): void => {
  // Called synchronously from the keydown task. Do not introduce an `await`
  // above this line.
  const started = writeClipboard(app.gm, text);
  if (started.isErr()) {
    app.hud.error(`Copy failed: ${started.error.message}`);
    return;
  }
  app.hud.show(`Copied ${label}`);
  void started.value.settled.then((result) => {
    if (result.isErr()) app.hud.error(`Copy failed: ${result.error.message}`);
  });
};

/**
 * Act on a hint that belongs to *this* frame.
 *
 * Exported so the cross-frame layer can drive it on behalf of another frame,
 * which is why `origin` exists: a remote activation is an action requested by
 * another document, and two of the modes here are capabilities that a page must
 * not be able to spend on the user's behalf.
 */
export const activateLocalHint = (
  app: AppContext,
  hint: LocalHint,
  kind: HintModeKind,
  origin: ActivationOrigin = "local",
): void => {
  const element = hint.element;

  // Defence in depth behind the coordinator's round check. The reasoning that
  // used to stand here — that a remote copy "runs outside any keydown task and
  // will therefore usually be denied" — is wrong: `writeClipboard` catches the
  // rejection from `navigator.clipboard` and falls back to `GM_setClipboard`,
  // which needs no activation at all. A silent clipboard write with attacker-
  // chosen contents is a well-worn phishing primitive.
  if (origin === "remote" && COPY_MODES.has(kind)) {
    app.hud.error("Ignored a clipboard request from another frame.");
    return;
  }

  switch (kind) {
    case "activate":
      simulateClick(element);
      return;

    case "activate-new-tab":
    case "activate-new-tab-background": {
      if (hint.href === null) {
        // Nothing to hand to `openTab`, and a synthetic modifier-click would be
        // a plain click. Do the honest thing and say what happened.
        simulateClick(element);
        app.hud.show("No link URL: activated in this tab.");
        return;
      }
      openInNewTab(app, hint.href, kind === "activate-new-tab");
      return;
    }

    case "hover":
      simulateHover(element);
      return;

    case "focus":
      if (element instanceof HTMLElement || element instanceof SVGElement) {
        element.focus({ preventScroll: true });
      }
      return;

    case "copy-link-url":
      if (hint.href === null) {
        app.hud.error("That hint has no URL to copy.");
        return;
      }
      copy(app, hint.href, hint.href);
      return;

    case "copy-link-text":
      copy(app, hint.linkText, "link text");
      return;

    case "open-with-omnibar":
      // `OmnibarApi.open` takes no initial query, so the URL cannot be
      // pre-filled; showing it keeps the command useful rather than confusing.
      if (hint.href !== null) app.hud.show(hint.href);
      app.omnibar.open("url");
      return;

    case "download":
      // Tier C. Upstream implements this as a synthetic alt-click, which WebKit
      // does not route to the download path for an untrusted event.
      app.hud.error(
        "Download-link hints are not implementable in a userscript on WebKit: " +
          "a synthetic alt-click is untrusted and never reaches the download " +
          "path. Use the context menu (⌃-click → Download Linked File).",
      );
      return;
  }
};

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * One hint in the session's globally-ordered list.
 *
 * `hint` is non-`null` only for hints owned by this frame; every frame holds
 * the same list in the same order, and only the owner can draw or activate.
 */
export interface HintEntry {
  readonly frameId: FrameId;
  readonly localIndex: number;
  readonly linkText: string;
  readonly secondary: boolean;
  readonly hint: LocalHint | null;
}

export interface HintModeConfig {
  readonly app: AppContext;
  readonly kind: HintModeKind;
  readonly entries: readonly HintEntry[];
  /** Broadcast keystrokes so sibling frames stay in lockstep. */
  readonly crossFrame: boolean;
  /**
   * Whether this frame started the round.
   *
   * A cross-frame round runs the *same* mode in every frame so that each one
   * draws its own markers with the hint strings everybody agreed on. Only the
   * origin acts on the result: every frame reaches the same conclusion from the
   * same keystrokes, so if participants activated too, a hint would be followed
   * once per frame on the page.
   *
   * Defaults to `"origin"`, which is the single-frame case.
   */
  readonly role?: "origin" | "participant";
}

const INDICATORS: Readonly<Record<HintModeKind, string>> = {
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

/** How long a pause in typing counts as confirmation of a single match. */
export const FILTER_CONFIRM_DELAY_MS = 200;

/** `"a"` → `"a"`, `"<space>"` → `" "`, `"<c-a>"` → `null`. */
const printableChar = (notation: string): string | null => {
  if (notation === "<space>") return " ";
  return [...notation].length === 1 ? notation : null;
};

// ---------------------------------------------------------------------------
// The mode
// ---------------------------------------------------------------------------

export class HintMode extends Mode {
  readonly #app: AppContext;
  readonly #kind: HintModeKind;
  readonly #entries: readonly HintEntry[];
  readonly #crossFrame: boolean;
  readonly #isOrigin: boolean;
  readonly #markers: MarkerLayer;

  /** Indices into `#entries` that this frame owns, in order. */
  readonly #localPositions: readonly number[];

  readonly #filtering: boolean;
  readonly #alphabet: string;
  readonly #numbers: string;
  readonly #hints: readonly string[];
  readonly #candidates: readonly FilterCandidate[];

  #typed = "";
  #textQueue = "";
  #digitQueue = "";
  #outcome: FilterOutcome;
  #activeIndex = 0;
  #confirmTimer: number | null = null;

  constructor(config: HintModeConfig) {
    super(config.app.modeHost, {
      name: "hints",
      indicator: INDICATORS[config.kind],
      exitOnEscape: true,
      // Hint mode owns the keyboard outright: an unhandled key must not reach
      // the page, or `j` scrolls while the user is picking a link.
      suppressAllKeyboardEvents: true,
      singleton: "hints",
    });

    const settings = config.app.settings();
    this.#app = config.app;
    this.#kind = config.kind;
    this.#entries = config.entries;
    this.#crossFrame = config.crossFrame;
    this.#isOrigin = config.role !== "participant";
    this.#filtering = settings.filterLinkHints;
    this.#alphabet = normaliseHintCharacters(
      settings.linkHintCharacters,
      "sadfjklewcmpgh",
    );
    this.#numbers = normaliseHintCharacters(
      settings.linkHintNumbers,
      "0123456789",
    );

    this.#localPositions = config.entries
      .map((entry, index) => (entry.hint === null ? -1 : index))
      .filter((index) => index >= 0);

    this.#hints = this.#filtering
      ? []
      : hintStrings(config.entries.length, this.#alphabet);

    this.#candidates = config.entries.map((entry, index) => ({
      index,
      linkText: entry.linkText,
      secondary: entry.secondary,
    }));

    this.#outcome = this.#filter();
    this.#markers = new MarkerLayer(config.app);

    this.onExit((reason) => {
      this.#clearTimer();
      this.#markers.dispose();
      this.#app.hud.hide();
      // Escape means "undo what I was pointing at"; an explicit activation
      // means the hover was intentional and must survive.
      if (reason === "escape") releaseHover();
    });
  }

  /** Draw the initial markers. Call immediately after `enter()`. */
  start(): void {
    this.#render();
  }

  /** Feed a key that arrived somewhere else: a replayed buffer, or a sibling frame. */
  handleKey(notation: string): void {
    if (!this.isActive) return;

    if (notation === "<esc>") {
      this.exit("escape");
      return;
    }
    if (notation === "<backspace>" || notation === "<delete>") {
      this.#backspace();
      return;
    }

    if (this.#filtering) {
      if (notation === "<enter>") {
        this.#activateActive();
        return;
      }
      if (notation === "<tab>") {
        this.#cycle(1);
        return;
      }
      if (notation === "<s-tab>") {
        this.#cycle(-1);
        return;
      }
    }

    const char = printableChar(notation);
    if (char === null) return;
    this.#appendChar(char);
  }

  /** Replay keys buffered while the cross-frame round trip was in flight. */
  replay(notations: readonly string[]): void {
    for (const notation of notations) {
      if (!this.isActive) return;
      this.handleKey(notation);
    }
  }

  protected override handlers(): Omit<Handler, "name"> {
    return { keydown: (event) => this.#onKeydown(event) };
  }

  #onKeydown(event: KeyboardEvent): HandlerResult {
    // Mid-composition keystrokes belong to the IME, not to us.
    if (event.isComposing) return SUPPRESS_EVENT;

    const notation = keyNotation(
      event,
      this.#app.settings().ignoreKeyboardLayout,
    );
    if (notation === null) return SUPPRESS_EVENT;

    this.handleKey(notation);
    // Broadcast *after* handling so this frame activates from inside the
    // keydown task; a copy mode that waited for the round trip would have lost
    // its transient activation.
    if (this.#crossFrame) this.#app.frames.broadcastKey(notation);
    return SUPPRESS_EVENT;
  }

  // -- input -----------------------------------------------------------------

  #appendChar(char: string): void {
    if (this.#filtering) {
      if (this.#numbers.includes(char)) this.#digitQueue += char;
      else this.#textQueue += char;
      this.#update();
      return;
    }

    const lower = char.toLowerCase();
    if (!this.#alphabet.includes(lower)) return;
    this.#typed += lower;
    this.#update();
  }

  #backspace(): void {
    if (this.#filtering) {
      if (this.#digitQueue.length > 0) {
        this.#digitQueue = this.#digitQueue.slice(0, -1);
      } else if (this.#textQueue.length > 0) {
        this.#textQueue = this.#textQueue.slice(0, -1);
      } else {
        this.exit("escape");
        return;
      }
      this.#update();
      return;
    }

    if (this.#typed.length === 0) {
      this.exit("escape");
      return;
    }
    this.#typed = this.#typed.slice(0, -1);
    this.#update();
  }

  #cycle(direction: 1 | -1): void {
    const count = this.#outcome.candidates.length;
    if (count === 0) return;
    this.#activeIndex = (this.#activeIndex + direction + count) % count;
    // Tab is an explicit "not that one" — cancel any pending auto-activation.
    this.#clearTimer();
    this.#render();
  }

  // -- matching --------------------------------------------------------------

  #filter(): FilterOutcome {
    return filterHints(this.#candidates, {
      text: this.#textQueue,
      digits: this.#digitQueue,
      numberCharacters: this.#numbers,
    });
  }

  #update(): void {
    this.#clearTimer();

    if (!this.#filtering) {
      const matches = matchByPrefix(this.#hints, this.#typed);
      if (matches.length === 0) {
        // Only the origin frame speaks: one HUD message per page, not one per
        // frame that happens to be running the same round.
        if (this.#isOrigin) this.#app.hud.show("No matching hint", 800);
        this.exit("explicit");
        return;
      }
      const only = matches.length === 1 ? matches[0] : undefined;
      if (only !== undefined && this.#hints[only] === this.#typed) {
        this.#activateIndex(only);
        return;
      }
      this.#render();
      return;
    }

    this.#outcome = this.#filter();
    this.#activeIndex = 0;
    this.#render();

    if (this.#outcome.candidates.length === 0) {
      if (this.#isOrigin) {
        this.#app.hud.show(`No matches for "${this.#queryText()}"`);
      }
      return;
    }
    this.#showQuery();

    const exact = this.#outcome.exact;
    if (exact === null || this.#outcome.candidates.length !== 1) return;

    if (!this.#app.settings().waitForEnterForFilteredHints) {
      this.#activateIndex(exact.index);
      return;
    }
    // Confirmation: Enter activates immediately, and so does a pause in typing.
    // The pause matters because filter mode narrows to one match long before
    // the user has finished typing the word they had in mind.
    this.#confirmTimer = setTimeout(() => {
      this.#confirmTimer = null;
      this.#activateIndex(exact.index);
    }, FILTER_CONFIRM_DELAY_MS);
  }

  #queryText(): string {
    return `${this.#textQueue}${this.#digitQueue}`.trim();
  }

  #showQuery(): void {
    if (!this.#isOrigin) return;
    const query = this.#queryText();
    if (query.length > 0) this.#app.hud.show(query);
  }

  // -- rendering -------------------------------------------------------------

  #render(): void {
    this.#markers.render(
      this.#filtering ? this.#filterSpecs() : this.#alphabetSpecs(),
    );
  }

  #alphabetSpecs(): readonly MarkerSpec[] {
    const specs: MarkerSpec[] = [];
    for (const position of this.#localPositions) {
      const entry = this.#entries[position];
      if (entry === undefined || entry.hint === null) continue;
      const hint = entry.hint;
      const hintString = this.#hints[position] ?? "";
      specs.push({
        rect: hint.rect,
        hintString,
        matchedLength: this.#typed.length,
        secondary: entry.secondary,
        active: false,
        linkText: hint.linkText,
        showLinkText: false,
        hidden: !hintString.startsWith(this.#typed),
      });
    }
    return specs;
  }

  #filterSpecs(): readonly MarkerSpec[] {
    const numbering = new Map<number, FilterMatch>();
    for (const match of this.#outcome.matched) {
      numbering.set(match.index, match);
    }
    const visible = new Set(
      this.#outcome.candidates.map((match) => match.index),
    );
    const activeIndex = this.#outcome.candidates[this.#activeIndex]?.index;

    const specs: MarkerSpec[] = [];
    for (const position of this.#localPositions) {
      const entry = this.#entries[position];
      if (entry === undefined || entry.hint === null) continue;
      const hint = entry.hint;
      const match = numbering.get(position);
      specs.push({
        rect: hint.rect,
        hintString: match?.hintString ?? "",
        matchedLength: this.#digitQueue.length,
        secondary: entry.secondary,
        active: position === activeIndex,
        linkText: hint.linkText,
        showLinkText: hint.showLinkText,
        hidden: match === undefined || !visible.has(position),
      });
    }
    return specs;
  }

  // -- activation ------------------------------------------------------------

  #activateActive(): void {
    const match = this.#outcome.candidates[this.#activeIndex];
    if (match === undefined) return;
    this.#activateIndex(match.index);
  }

  #activateIndex(index: number): void {
    const entry = this.#entries[index];
    if (entry === undefined) return;

    // Tear the overlay down first: activation may move focus, and a marker
    // still in the tree would be visible for a frame after navigation starts.
    this.exit("explicit");

    // A participant frame renders and follows along, but the origin is the one
    // that dispatches — either locally or as an `ACTIVATE_HINT` addressed to
    // whichever frame owns the entry, which may well be this one.
    if (!this.#isOrigin) return;

    if (entry.hint !== null) {
      activateLocalHint(this.#app, entry.hint, this.#kind);
      return;
    }
    this.#app.frames.activateHint(entry.frameId, entry.localIndex, this.#kind);
  }

  #clearTimer(): void {
    if (this.#confirmTimer === null) return;
    clearTimeout(this.#confirmTimer);
    this.#confirmTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Key buffering during the cross-frame round trip
// ---------------------------------------------------------------------------

/** Give up buffering after this long, rather than eating the user's keyboard. */
export const KEY_BUFFER_SAFETY_MS = 1000;

/**
 * Swallow and record keys while hints are being collected.
 *
 * A cross-frame collection is time-boxed at three seconds, and a user who has
 * already typed `fab` should not lose `ab`. The safety timer exists because the
 * alternative failure — a page whose keyboard is dead because a frame hung — is
 * far worse than a couple of dropped keystrokes.
 */
export class KeyBufferMode extends Mode {
  readonly #keys: string[] = [];
  readonly #app: AppContext;
  #timer: number | null = null;

  constructor(app: AppContext) {
    super(app.modeHost, {
      name: "hints/buffer",
      exitOnEscape: true,
      suppressAllKeyboardEvents: true,
      singleton: "hints",
    });
    this.#app = app;
    this.onExit(() => {
      if (this.#timer !== null) clearTimeout(this.#timer);
      this.#timer = null;
    });
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.exit("explicit");
    }, KEY_BUFFER_SAFETY_MS);
  }

  keys(): readonly string[] {
    return [...this.#keys];
  }

  protected override handlers(): Omit<Handler, "name"> {
    return {
      keydown: (event: KeyboardEvent): HandlerResult => {
        const notation = keyNotation(
          event,
          this.#app.settings().ignoreKeyboardLayout,
        );
        if (notation !== null && notation !== "<esc>") {
          this.#keys.push(notation);
        }
        return SUPPRESS_EVENT;
      },
    };
  }
}
