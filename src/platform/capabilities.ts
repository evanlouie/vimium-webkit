/**
 * Runtime capability probe (IMPLEMENTATION_PLAN.md §6.2).
 *
 * Rules this module exists to enforce:
 *
 * 1. **Probe, don't sniff.** `manager` is recorded for bug reports only; no
 *    behaviour may branch on it.
 * 2. **Every `false` has a defined behaviour**, and where that behaviour is
 *    user-visible it must produce a HUD message on first attempt.
 * 3. **No probe may throw.** Reading a global is not safe in a userscript (see
 *    `platform/ambient.ts`), and this module runs before anything else in
 *    Stage 1 — an exception here costs the whole boot rather than one
 *    capability.
 */

import {
  detectGmSurface,
  type GmSurface,
  readManagerIdentity,
  selectValueBackend,
} from "./gm.ts";
import { STORAGE_PREFIX } from "./storage.ts";
import {
  clipboardReader,
  clipboardWriter,
  probe,
  userAgent,
} from "./ambient.ts";
import { hasNativeIdleCallback } from "./scheduler.ts";

export type ManagerName =
  | "violentmonkey"
  | "tampermonkey"
  | "userscripts"
  | "stay"
  | "greasemonkey"
  | "scriptcat"
  | "unknown";

export type ValueStoreKind =
  | "gm-sync"
  | "gm-async"
  | "localstorage-fallback"
  | "memory";

export interface Capabilities {
  // --- Identity (diagnostics only) ---
  readonly manager: ManagerName;
  readonly managerVersion: string | null;
  readonly scriptVersion: string | null;
  readonly world: "page" | "content" | "unknown";

  // --- GM surface ---
  readonly value: ValueStoreKind;
  readonly valueChangeListener: boolean;
  readonly openInTab: boolean;
  readonly openInTabBackground: boolean;
  readonly setClipboard: boolean;
  readonly xhr: boolean;
  readonly menuCommand: boolean;
  readonly windowClose: boolean;

  // --- Platform surface ---
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

/**
 * Recorded for the `:capabilities` dump and the help-dialog footer only.
 *
 * `GM_info.scriptHandler` is a display string, not a contract: Tampermonkey's
 * Safari build, Stay, and ScriptCat all masquerade to varying degrees, and new
 * managers appear regularly. Anything that behaves differently per manager is a
 * bug in this codebase.
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
 * Best-effort world detection.
 *
 * Violentmonkey reports `injectInto` in `GM_info`. Everywhere else we infer:
 * if a `GM.*` member exists but `unsafeWindow` does not, we are almost
 * certainly isolated. This is diagnostic, not load-bearing — see §5.3 for why
 * world choice does not affect keyboard interception.
 */
const detectWorld = (
  injectInto: string | null,
  surface: GmSurface,
): Capabilities["world"] => {
  if (injectInto === "content" || injectInto === "auto") return "content";
  if (injectInto === "page") return "page";
  if (surface.hasUnsafeWindow) return "page";
  if (surface.namespace !== null || surface.getValueSync !== null) {
    return "content";
  }
  return "unknown";
};

/**
 * Every probe below is wrapped in `probe`, which turns a throw into "absent".
 *
 * That is not defensive padding: a userscript does not own its globals, and
 * this module runs first in Stage 1, so one hostile accessor would cost the
 * whole boot rather than one capability. See `platform/ambient.ts`.
 */
const supportsAdoptedStyleSheets = (): boolean =>
  probe(() => {
    if (typeof CSSStyleSheet !== "function") return false;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(":host{color:inherit}");
    // Writability of `adoptedStyleSheets` is the part that actually varies;
    // Safari 16.4 / Chrome 111 / Firefox 101 are the floors.
    const probeRoot = document.createElement("div").attachShadow({
      mode: "closed",
    });
    probeRoot.adoptedStyleSheets = [sheet];
    return probeRoot.adoptedStyleSheets.length === 1;
  }, false);

const supportsSelectionModify = (): boolean =>
  probe(() => {
    const selection = globalThis.getSelection();
    return selection !== null &&
      typeof (selection as { modify?: unknown }).modify === "function";
  }, false);

/**
 * Are we on WebKit?
 *
 * Used only to decide whether to *warn* about WebKit-specific degradations, so
 * a false negative costs a missing hint, not a broken feature. There is no
 * feature-detectable proxy for "this engine reserves ⌘T", hence the sniff.
 */
const detectWebKit = (): boolean => {
  const ua = userAgent();
  const isAppleWebKit = ua.includes("AppleWebKit");
  const isBlink = ua.includes("Chrome/") || ua.includes("Chromium/") ||
    ua.includes("Edg/");
  return isAppleWebKit && !isBlink;
};

export const probeCapabilities = (
  surface: GmSurface = detectGmSurface(),
): Capabilities => {
  const identity = readManagerIdentity(surface.info);
  const manager = identifyManager(identity.handler);

  // Asked of the selector rather than re-derived. The two predicates had
  // drifted: this one needed two members where `selectValueBackend` needs
  // three, so a manager with `GM.getValue`/`setValue` but no `GM.deleteValue`
  // was reported as `gm-async` while its data actually went to `localStorage`
  // — which WebKit erases after seven days without a visit — and
  // `degradationWarnings` therefore told the user nothing. One source of truth
  // removes the whole class.
  const value: ValueStoreKind =
    selectValueBackend(surface, STORAGE_PREFIX).kind;

  return {
    manager,
    managerVersion: identity.handlerVersion,
    scriptVersion: identity.scriptVersion,
    world: detectWorld(identity.injectInto, surface),

    value,
    valueChangeListener: surface.addValueChangeListener !== null,
    openInTab: Boolean(surface.namespace?.openInTab) ||
      surface.openInTabSync !== null,
    // No manager in our matrix rejects `{active:false}` outright, but quoid
    // ignores it. Treated as "available" and verified empirically (V6).
    openInTabBackground: Boolean(surface.namespace?.openInTab) ||
      surface.openInTabSync !== null,
    setClipboard: Boolean(surface.namespace?.setClipboard) ||
      surface.setClipboardSync !== null,
    xhr: Boolean(surface.namespace?.xmlHttpRequest) || surface.xhrSync !== null,
    menuCommand: surface.registerMenuCommand !== null ||
      Boolean(surface.namespace?.registerMenuCommand),
    windowClose: surface.windowClose !== null,

    adoptedStyleSheets: supportsAdoptedStyleSheets(),
    constructableStyleSheets: probe(
      () => typeof CSSStyleSheet === "function",
      false,
    ),
    checkVisibility: probe(
      () => typeof Element.prototype.checkVisibility === "function",
      false,
    ),
    composedRanges: probe(
      () =>
        typeof (Selection.prototype as { getComposedRanges?: unknown })
          .getComposedRanges === "function",
      false,
    ),
    caretPositionFromPoint: probe(
      () =>
        typeof (document as { caretPositionFromPoint?: unknown })
          .caretPositionFromPoint === "function",
      false,
    ),
    caretRangeFromPoint: probe(
      () =>
        typeof (document as { caretRangeFromPoint?: unknown })
          .caretRangeFromPoint === "function",
      false,
    ),
    selectionModify: supportsSelectionModify(),
    // The same accessors the clipboard module will actually call, so the
    // capability and the feature cannot disagree about what exists.
    clipboardWrite: clipboardWriter() !== null,
    clipboardRead: clipboardReader() !== null,
    idleCallback: probe(() => hasNativeIdleCallback(), false),
    visualViewport: probe(
      () =>
        typeof globalThis.visualViewport === "object" &&
        globalThis.visualViewport !== null,
      false,
    ),
    secureContext: probe(() => globalThis.isSecureContext === true, false),
    webkitLike: detectWebKit(),
  };
};

/**
 * Warnings the user needs to see once per session, in priority order.
 *
 * Every entry corresponds to a capability whose absence silently changes
 * behaviour. Anything that merely disables an optional feature belongs in the
 * help dialog, not here.
 */
export const degradationWarnings = (caps: Capabilities): readonly string[] => {
  const warnings: string[] = [];

  if (caps.value === "localstorage-fallback") {
    warnings.push(
      "Settings are stored in localStorage and Safari will erase them after " +
        "7 days of inactivity. Install Tampermonkey or Userscripts for durable storage.",
    );
  } else if (caps.value === "memory") {
    warnings.push(
      "No storage is available — settings and marks will be lost when this page unloads.",
    );
  }

  if (!caps.adoptedStyleSheets) {
    warnings.push(
      "This browser predates constructable stylesheets (Safari 16.4). " +
        "Vimium-WebKit's overlay may be blocked by strict Content Security Policies.",
    );
  }

  if (!caps.openInTab) {
    warnings.push(
      "Your userscript manager does not provide GM.openInTab; new-tab commands " +
        "will fall back to window.open and may be blocked.",
    );
  }

  if (!caps.clipboardWrite && !caps.setClipboard) {
    warnings.push("No clipboard API is available; copy commands are disabled.");
  }

  return warnings;
};

/** Copy-pasteable diagnostics for bug reports. */
export const formatCapabilities = (caps: Capabilities): string =>
  Object.entries(caps)
    .map(([key, value]) => `${key.padEnd(24)} ${String(value)}`)
    .join("\n");
