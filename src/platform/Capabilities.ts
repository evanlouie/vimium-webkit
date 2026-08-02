/**
 * What this realm can do, probed once at start.
 *
 * Three rules hold this module together:
 *
 * 1. **Probe, do not sniff.** The manager name is kept for a bug report only.
 *    No behaviour may branch on it.
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

import { Context, Effect, Layer, Option, Predicate } from "effect";
import { clipboardReader, clipboardWriter } from "~/platform/Clipboard.ts";
import { Dom } from "~/platform/Dom.ts";
import { Gm } from "~/platform/Gm.ts";
import { type KeyValueKind, KeyValueStore } from "~/platform/KeyValueStore.ts";
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
const identifyManager = (handler: string | null): ManagerName => {
  const name = (handler ?? "").toLowerCase();
  if (name.includes("violentmonkey")) return "violentmonkey";
  if (name.includes("tampermonkey")) return "tampermonkey";
  if (name.includes("scriptcat")) return "scriptcat";
  if (name.includes("userscripts")) return "userscripts";
  if (name.includes("stay")) return "stay";
  if (name.includes("greasemonkey")) return "greasemonkey";
  return "unknown";
};

/**
 * The world, as well as we can tell.
 *
 * Violentmonkey reports `injectInto`. Everywhere else we infer it: a manager
 * value API without `unsafeWindow` is almost always an isolated world. This is
 * a diagnostic. The choice of world does not change how keys are intercepted.
 */
const detectWorld = (
  injectInto: string | null,
  hasUnsafeWindow: boolean,
  hasValueApi: boolean,
): WorldName => {
  if (injectInto === "content" || injectInto === "auto") return "content";
  if (injectInto === "page") return "page";
  if (hasUnsafeWindow) return "page";
  if (hasValueApi) return "content";
  return "unknown";
};

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

const isCallable = (owner: object, member: string): boolean => {
  const value: unknown = Reflect.get(owner, member);
  return Predicate.isFunction(value);
};

/**
 * Read the report.
 *
 * Every browser read is inside `dom.probeOr`, so a poisoned global gives
 * `false` and not a defect.
 */
export const probeCapabilities: Effect.Effect<
  CapabilityReport,
  never,
  Gm | KeyValueStore | Dom
> = Effect.gen(function*() {
  const gm = yield* Gm;
  const kv = yield* KeyValueStore;
  const dom = yield* Dom;
  const win = dom.window;
  const doc = dom.document;

  const flag = (read: () => boolean): Effect.Effect<boolean> =>
    dom.probeOr(read, false);

  /**
   * Constructable stylesheets, and a shadow root that accepts them.
   *
   * The writable `adoptedStyleSheets` is the part that changes between
   * engines. Safari 16.4, Chrome 111 and Firefox 101 are the floors.
   */
  const adoptedStyleSheets = yield* flag(() => {
    if (typeof CSSStyleSheet !== "function") return false;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(":host{color:inherit}");
    const root = doc.createElement("div").attachShadow({ mode: "closed" });
    root.adoptedStyleSheets = [sheet];
    return root.adoptedStyleSheets.length === 1;
  });

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
    if (!Predicate.isString(ua)) return false;
    const isAppleWebKit = ua.includes("AppleWebKit");
    const isBlink = ua.includes("Chrome/") || ua.includes("Chromium/") ||
      ua.includes("Edg/");
    return isAppleWebKit && !isBlink;
  });

  const constructableStyleSheets = yield* flag(
    () => typeof CSSStyleSheet === "function",
  );
  const checkVisibility = yield* flag(
    () => isCallable(Element.prototype, "checkVisibility"),
  );
  const composedRanges = yield* flag(
    () => isCallable(Selection.prototype, "getComposedRanges"),
  );
  const caretPositionFromPoint = yield* flag(
    () => isCallable(doc, "caretPositionFromPoint"),
  );
  const caretRangeFromPoint = yield* flag(
    () => isCallable(doc, "caretRangeFromPoint"),
  );
  // The same accessors that `Clipboard` calls, so the report and the feature
  // cannot disagree about what exists.
  const clipboardWrite = yield* flag(() => clipboardWriter(win) !== null);
  const clipboardRead = yield* flag(() => clipboardReader(win) !== null);
  const idleCallback = yield* flag(() => hasNativeIdleCallback(win));
  const visualViewport = yield* flag(() => {
    const viewport: unknown = win.visualViewport;
    return Predicate.isObjectKeyword(viewport);
  });
  const secureContext = yield* flag(() => win.isSecureContext === true);

  const identity = gm.identity;

  return {
    manager: identifyManager(identity.handler),
    managerVersion: identity.handlerVersion,
    scriptVersion: identity.scriptVersion,
    world: detectWorld(
      identity.injectInto,
      gm.hasUnsafeWindow,
      Option.isSome(gm.values),
    ),

    // Asked of the store that is in use, and not derived again. The two
    // predicates had moved apart before: a manager with `GM.getValue` and
    // `GM.setValue` but no `GM.deleteValue` was reported as `gm-async` while
    // its data went to `localStorage`, which WebKit erases after seven days.
    // The warning then said nothing. One source of truth removes that class of
    // defect.
    value: kv.kind,
    valueChangeListener: kv.watchable,
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
export const degradationWarnings = (
  report: CapabilityReport,
): readonly string[] => {
  const warnings: string[] = [];

  if (report.value === "memory") {
    warnings.push(
      "No durable storage is available. Your userscript manager gives no " +
        "value store, so settings and marks are lost when this page unloads. " +
        "Install Tampermonkey or Userscripts for durable storage.",
    );
  }

  if (!report.adoptedStyleSheets) {
    warnings.push(
      "This browser is older than constructable stylesheets (Safari 16.4). " +
        "A strict Content Security Policy can block the overlay.",
    );
  }

  if (!report.openInTab) {
    warnings.push(
      "Your userscript manager does not give GM.openInTab. New-tab commands " +
        "use window.open, and the browser can block it.",
    );
  }

  if (!report.clipboardWrite && !report.setClipboard) {
    warnings.push("No clipboard API is available. Copy commands are off.");
  }

  return warnings;
};

/** The report as text, for a bug report. */
export const formatCapabilities = (report: CapabilityReport): string =>
  Object.entries(report)
    .map(([key, value]) => `${key.padEnd(24)} ${String(value)}`)
    .join("\n");

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Capabilities
  extends Context.Service<Capabilities, CapabilityReport>()(
    "vimium/platform/Capabilities",
  )
{
  static readonly layer: Layer.Layer<
    Capabilities,
    never,
    Gm | KeyValueStore | Dom
  > = Layer.effect(Capabilities, probeCapabilities);
}
