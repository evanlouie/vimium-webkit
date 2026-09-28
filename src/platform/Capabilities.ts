/**
 * What this realm can do, probed once at start.
 *
 * Three rules hold this module together:
 *
 * 1. **Probe, do not sniff.** One exception identifies an Apple platform.
 *    No feature test can identify the behaviour of the Option key.
 * 2. **Every `false` has a defined behaviour.** Where the user can see that
 *    behaviour, the first attempt must give a HUD message.
 * 3. **No probe may throw.** A userscript does not own its globals, and this
 *    service is built early. One hostile accessor must cost one capability,
 *    and not the whole start. Every read below is inside `dom.probeOr`.
 *
 * The old module built the manager surface and chose the value backend itself.
 * It does not do that now. It reads `Gm`, `KeyValueStore` and `Dom`, which are
 * already built, so the report and the services can never disagree.
 */

import { Array, Context, Effect, Layer, Match, Option, Predicate, Record, pipe } from "effect";
import { constFalse } from "effect/Function";
import { clipboardReader, clipboardWriter } from "~/platform/Clipboard.ts";
import { Dom } from "~/platform/Dom.ts";
import { Gm } from "~/platform/Gm.ts";
import { type KeyValueKind, kindName, KeyValueStore, StoreKind } from "~/platform/KeyValueStore.ts";
import { hasNativeIdleCallback } from "~/platform/Scheduler.ts";

export type ManagerName =
  | "violentmonkey"
  | "tampermonkey"
  | "userscripts"
  | "stay"
  | "greasemonkey"
  | "scriptcat"
  | "unknown";

export type WorldName = "page" | "content" | "unknown";

export interface CapabilityReport {
  // --- Identity. For diagnostics only. ---
  readonly manager: ManagerName;
  readonly managerVersion: string | null;
  readonly scriptVersion: string | null;
  readonly world: WorldName;

  // --- The manager surface ---
  readonly value: KeyValueKind;
  readonly valueChangeListener: boolean;
  readonly openInTab: boolean;
  readonly openInTabBackground: boolean;
  readonly setClipboard: boolean;
  readonly xhr: boolean;
  readonly menuCommand: boolean;
  readonly windowClose: boolean;

  // --- The browser surface ---
  readonly adoptedStyleSheets: boolean;
  readonly constructableStyleSheets: boolean;
  readonly checkVisibility: boolean;
  readonly composedRanges: boolean;
  readonly caretPositionFromPoint: boolean;
  readonly caretRangeFromPoint: boolean;
  readonly selectionModify: boolean;
  readonly clipboardWrite: boolean;
  readonly clipboardRead: boolean;
  readonly idleCallback: boolean;
  readonly visualViewport: boolean;
  readonly secureContext: boolean;
  readonly webkitLike: boolean;
  readonly applePlatform: boolean;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Kept for the capability dump and the help dialog only.
 *
 * `GM_info.scriptHandler` is a display string, and not a contract. The Safari
 * build of Tampermonkey, Stay and ScriptCat all report names of other
 * managers, and new managers appear often. Behaviour that changes with the
 * manager name is a defect in this application.
 */
const identifyManager = (handler: Option.Option<string>): ManagerName =>
  pipe(
    handler,
    Option.map((name) => name.toLowerCase()),
    Option.flatMap((name) =>
      pipe(
        KNOWN_MANAGERS,
        Array.findFirst((known) => name.includes(known)),
      ),
    ),
    Option.getOrElse((): ManagerName => "unknown"),
  );

/** The names that a handler string is searched for, in order. */
const KNOWN_MANAGERS: ReadonlyArray<ManagerName> = [
  "violentmonkey",
  "tampermonkey",
  "scriptcat",
  "userscripts",
  "stay",
  "greasemonkey",
];

/**
 * The world, as well as we can tell.
 *
 * Violentmonkey reports `injectInto`. Everywhere else we infer it: a manager
 * value API without `unsafeWindow` is almost always an isolated world. This is
 * a diagnostic. The choice of world does not change how keys are intercepted.
 */
const detectWorld = (
  injectInto: Option.Option<string>,
  hasUnsafeWindow: boolean,
  hasValueApi: boolean,
): WorldName =>
  pipe(
    injectInto,
    Option.flatMap(reportedWorld),
    Option.getOrElse(() => inferredWorld(hasUnsafeWindow, hasValueApi)),
  );

const reportedWorld = (injectInto: string): Option.Option<WorldName> =>
  pipe(
    Match.value(injectInto),
    Match.withReturnType<Option.Option<WorldName>>(),
    Match.whenOr("content", "auto", () => Option.some("content")),
    Match.when("page", () => Option.some("page")),
    Match.orElse(() => Option.none()),
  );

const inferredWorld = (hasUnsafeWindow: boolean, hasValueApi: boolean): WorldName =>
  pipe(
    Match.value({ hasUnsafeWindow, hasValueApi }),
    Match.withReturnType<WorldName>(),
    Match.when({ hasUnsafeWindow: true }, () => "page"),
    Match.when({ hasValueApi: true }, () => "content"),
    Match.orElse(() => "unknown"),
  );

/**
 * Is this macOS, iOS or iPadOS?
 *
 * `domain/Key.ts` reads it for one rule: on an Apple platform, Option changes
 * the character that a key makes, and the key notation must undo that. On
 * every other platform Alt leaves the character alone.
 *
 * There is no feature test for a keyboard modifier, so the user agent is read.
 * A wrong `false` costs the Option chords, and a wrong `true` costs an Alt
 * chord that makes a character. Both are one class of binding, and not the
 * start of the application.
 *
 * iPadOS reports a Macintosh user agent, which is correct for this question:
 * a hardware keyboard on an iPad has the Option key of macOS.
 */
export const isApplePlatform = (userAgent: string, platform: string): boolean =>
  /Mac|iPhone|iPad|iPod/.test(`${userAgent} ${platform}`);

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

const isCallable = (owner: object, member: string): boolean => {
  const value: unknown = Reflect.get(owner, member);
  return Predicate.isFunction(value);
};

/** Does a shadow root accept a constructed stylesheet? */
const adoptsStyleSheets = (doc: Document): boolean => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(":host{color:inherit}");
  const root = doc.createElement("div").attachShadow({ mode: "closed" });
  root.adoptedStyleSheets = [sheet];
  return root.adoptedStyleSheets.length === 1;
};

/** A WebKit user agent, and not a Blink one that also names `AppleWebKit`. */
const isWebKitAgent = (ua: string): boolean =>
  ua.includes("AppleWebKit") &&
  !(ua.includes("Chrome/") || ua.includes("Chromium/") || ua.includes("Edg/"));

/**
 * Read the report.
 *
 * Every browser read is inside `dom.probeOr`, so a poisoned global gives
 * `false` and not a defect.
 */
export const probeCapabilities: Effect.Effect<CapabilityReport, never, Gm | KeyValueStore | Dom> =
  Effect.gen(function* () {
    const gm = yield* Gm;
    const kv = yield* KeyValueStore;
    const dom = yield* Dom;
    const win = dom.window;
    const doc = dom.document;

    const flag = (read: () => boolean): Effect.Effect<boolean> => dom.probeOr(read, false);

    /**
     * Constructable stylesheets, and a shadow root that accepts them.
     *
     * The writable `adoptedStyleSheets` is the part that changes between
     * engines. Safari 16.4, Chrome 111 and Firefox 101 are the floors.
     */
    const adoptedStyleSheets = yield* flag(
      () => typeof CSSStyleSheet === "function" && adoptsStyleSheets(doc),
    );

    const selectionModify = yield* flag(() => {
      const selection = win.getSelection();
      return selection !== null && isCallable(selection, "modify");
    });

    /**
     * Are we on WebKit?
     *
     * This decides only whether to warn about a WebKit limit, so a wrong `false`
     * costs one message. No feature test can answer "this engine keeps ⌘T for
     * itself", and that is why the user agent is read here.
     */
    const webkitLike = yield* flag(() => {
      const ua: unknown = win.navigator.userAgent;
      return pipe(ua, Option.liftPredicate(Predicate.isString), Option.exists(isWebKitAgent));
    });

    const constructableStyleSheets = yield* flag(() => typeof CSSStyleSheet === "function");

    /**
     * Is this macOS, iOS or iPadOS?
     *
     * The answer decides how an Option chord is read. See `isApplePlatform`.
     */
    const applePlatform = yield* flag(() =>
      isApplePlatform(win.navigator.userAgent, win.navigator.platform),
    );

    const checkVisibility = yield* flag(() => isCallable(Element.prototype, "checkVisibility"));
    const composedRanges = yield* flag(() => isCallable(Selection.prototype, "getComposedRanges"));
    const caretPositionFromPoint = yield* flag(() => isCallable(doc, "caretPositionFromPoint"));
    const caretRangeFromPoint = yield* flag(() => isCallable(doc, "caretRangeFromPoint"));
    // The same accessors that `Clipboard` calls, so the report and the feature
    // cannot disagree about what exists.
    const clipboardWrite = yield* flag(() => Option.isSome(clipboardWriter(win)));
    const clipboardRead = yield* flag(() => Option.isSome(clipboardReader(win)));
    const idleCallback = yield* flag(() => hasNativeIdleCallback(win));
    const visualViewport = yield* flag(() => {
      const viewport: unknown = win.visualViewport;
      return Predicate.isObjectKeyword(viewport);
    });
    const secureContext = yield* flag(() => win.isSecureContext === true);

    const identity = gm.identity;

    return {
      manager: identifyManager(identity.handler),
      managerVersion: Option.getOrNull(identity.handlerVersion),
      scriptVersion: Option.getOrNull(identity.scriptVersion),
      world: detectWorld(identity.injectInto, gm.hasUnsafeWindow, Option.isSome(gm.values)),

      // Asked of the selected store, and not derived again. Separate predicates
      // can make the warning disagree with the selected backend. One source of
      // truth prevents that defect.
      value: kindName(kv.kind),
      valueChangeListener: pipe(
        kv.kind,
        StoreKind.$match({
          GmAsync: constFalse,
          GmSync: ({ watchable }) => watchable,
          Memory: constFalse,
        }),
      ),
      openInTab: gm.canOpenInTab,
      // No manager in the matrix refuses `{ active: false }`, but quoid ignores
      // it. Reported as available, and checked by hand.
      openInTabBackground: gm.canOpenInTab,
      setClipboard: gm.canSetClipboard,
      xhr: gm.canRequest,
      menuCommand: gm.canRegisterMenuCommand,
      windowClose: gm.canCloseWindow,

      adoptedStyleSheets,
      constructableStyleSheets,
      checkVisibility,
      composedRanges,
      caretPositionFromPoint,
      caretRangeFromPoint,
      selectionModify,
      clipboardWrite,
      clipboardRead,
      idleCallback,
      visualViewport,
      secureContext,
      webkitLike,
      applePlatform,
    };
  });

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * The warnings that the user must see once for each session, in order of
 * importance.
 *
 * Each entry names a capability whose absence changes behaviour without a
 * sign. A capability that only turns off an optional function belongs in the
 * help dialog, and not here.
 */
export const degradationWarnings = (report: CapabilityReport): readonly string[] =>
  pipe(
    WARNINGS,
    Array.filter(({ applies }) => applies(report)),
    Array.map(({ text }) => text),
  );

interface Warning {
  /** Does the report show the loss that the text names? */
  readonly applies: (report: CapabilityReport) => boolean;
  readonly text: string;
}

const WARNINGS: ReadonlyArray<Warning> = [
  {
    applies: (report) => report.value === "memory",
    text:
      "No durable storage is available. Your userscript manager gives no " +
      "value store, so your settings, marks and history are lost when this " +
      "page unloads. The frames of a page also stay apart: link hints across " +
      "frames and frame focus are off, and a frame does not learn that you " +
      "excluded the page. Install Tampermonkey or Userscripts for durable " +
      "storage.",
  },
  {
    applies: (report) => !report.adoptedStyleSheets,
    text:
      "This browser is older than constructable stylesheets (Safari 16.4). " +
      "A strict Content Security Policy can block the overlay.",
  },
  {
    applies: (report) => !report.openInTab,
    text:
      "Your userscript manager does not give GM.openInTab. New-tab commands " +
      "use window.open, and the browser can block it.",
  },
  {
    applies: (report) => !report.clipboardWrite && !report.setClipboard,
    text: "No clipboard API is available. Copy commands are off.",
  },
];

/** The report as text, for a bug report. */
export const formatCapabilities = (report: CapabilityReport): string =>
  pipe(
    report,
    Record.toEntries,
    Array.map(([key, value]) => `${key.padEnd(24)} ${String(value)}`),
    Array.join("\n"),
  );

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Capabilities extends Context.Service<Capabilities, CapabilityReport>()(
  "vimium/platform/Capabilities",
) {
  static readonly layer: Layer.Layer<Capabilities, never, Gm | KeyValueStore | Dom> = Layer.effect(
    Capabilities,
    probeCapabilities,
  );
}
