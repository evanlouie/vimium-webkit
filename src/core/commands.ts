/**
 * The command registry, and the tier table from IMPLEMENTATION_PLAN.md §4 made
 * executable.
 *
 * Every command carries a tier. Tier C commands are *registered*, not omitted:
 * they render greyed-out in the help dialog with the native Safari shortcut
 * alongside, and pressing the key produces an explanation rather than silence.
 * That is goal G3 — degrade visibly — and it turns a missing capability into a
 * discoverability win (§4.3).
 */

import type {
  AppContext,
  CommandDef,
  CommandGroup,
  CommandInvocation,
  CommandRegistry,
  HintMode,
} from "./context.ts";
import { Effect, Result } from "effect";
import { type Handler, SUPPRESS_EVENT } from "./handler-stack.ts";
import { Mode } from "./mode.ts";
import { isComposing, isModifierKey, keyNotation } from "./key-notation.ts";
import { Tabs } from "~/platform/tabs.ts";
import { Clipboard } from "~/platform/clipboard.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read exactly one more keystroke, then hand it to `callback`.
 *
 * Used by `m` and `` ` ``. A `Mode` rather than a bare handler, despite the
 * interaction being one key: a raw handler was invisible to `exitAllModes`, so
 * a soft navigation between `m` and the letter left it armed across the
 * navigation; it clobbered whatever indicator a live mode owned instead of
 * participating in the indicator stack; and a throwing callback took the
 * keystroke with it.
 */
class CaptureKeyMode extends Mode {
  readonly #app: AppContext;
  readonly #callback: (notation: string) => void;

  constructor(
    app: AppContext,
    prompt: string,
    callback: (notation: string) => void,
  ) {
    super(app.modeHost, {
      name: "capture-next-key",
      indicator: prompt,
      exitOnEscape: true,
      // Owns the keyboard outright: a stray `j` between `m` and the letter must
      // not scroll the page.
      suppressAllKeyboardEvents: true,
      singleton: "capture-next-key",
    });
    this.#app = app;
    this.#callback = callback;
  }

  protected override handlers(): Omit<Handler, "name"> {
    return {
      keydown: (event) => {
        if (isComposing(event) || isModifierKey(event)) return SUPPRESS_EVENT;
        const notation = keyNotation(
          event,
          this.#app.settings().ignoreKeyboardLayout,
        );
        if (notation === null) return SUPPRESS_EVENT;

        this.exit("explicit");
        try {
          this.#callback(notation);
        } catch (cause) {
          this.#app.hud.error(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
        return SUPPRESS_EVENT;
      },
    };
  }
}

const captureNextKey = (
  app: AppContext,
  prompt: string,
  callback: (notation: string) => void,
): void => {
  new CaptureKeyMode(app, prompt, callback).enter();
};

const copyToClipboard = (
  app: AppContext,
  text: string,
  label: string,
): void => {
  // `runSync`, not `runFork`, and reached synchronously from the keydown task:
  // every effect on this path is non-suspending, so the write still happens
  // inside WebKit's transient-activation window. Anything that suspended first
  // would spend the activation and the write would be denied.
  const outcome = app.runtime.runSync(
    Effect.result(Clipboard.use((clipboard) => clipboard.write(text))),
  );
  if (Result.isFailure(outcome)) {
    app.hud.error(`Could not copy: ${outcome.failure.detail}`);
    return;
  }
  app.hud.show(`Copied ${label}`);
  // The outcome may arrive later; that part is allowed to suspend.
  app.runtime.runFork(
    Effect.catch(
      outcome.success.settled,
      (error) =>
        Effect.sync(() => app.hud.error(`Copy failed: ${error.detail}`)),
    ),
  );
};

const openFromClipboard = (app: AppContext, newTab: boolean): void => {
  // WebKit either shows a native paste affordance or rejects outright unless
  // this origin wrote the clipboard, so the HUD input is the *primary* path and
  // the read is only an attempt to pre-fill it (§6.4). Started before the
  // prompt so the read races the user, not the other way round.
  app.runtime.runFork(
    Clipboard.use((clipboard) => clipboard.read).pipe(
      Effect.tap((text) =>
        Effect.sync(() => {
          if (text.trim().length > 0) {
            app.hud.show(`Clipboard: ${text.slice(0, 80)}`);
          }
        })
      ),
      // A denied or absent clipboard is the expected case here, not an error.
      Effect.ignore,
    ),
  );

  void app.hud.prompt({
    label: newTab ? "Open in new tab:" : "Open:",
    placeholder: "paste a URL (⌘V)",
  }).then((value) => {
    if (value === null || value.trim().length === 0) return;
    app.runtime.runFork(go(app, value.trim(), newTab));
  });
};

const go = (
  app: AppContext,
  input: string,
  newTab: boolean,
): Effect.Effect<void, never, Tabs> =>
  Effect.suspend(() => {
    const url = toUrl(input, app.settings().searchUrl);
    const attempt = newTab
      ? Effect.asVoid(Tabs.use((tabs) => tabs.open(url, { active: true })))
      : Tabs.use((tabs) => tabs.navigate(url));
    return Effect.catch(
      attempt,
      (error) => Effect.sync(() => app.hud.error(error.detail)),
    );
  });

/** Bare words become a search; anything URL-shaped is navigated to. */
export const toUrl = (input: string, searchUrl: string): string => {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$)/.test(trimmed)) return `https://${trimmed}`;
  return searchUrl.replace("%s", encodeURIComponent(trimmed));
};

/**
 * `[[` / `]]` — find the "previous"/"next" link.
 *
 * `rel` attributes win over text heuristics because they are unambiguous;
 * upstream does the same.
 */
export const findRelLink = (
  rel: "prev" | "next",
  patterns: readonly string[],
): HTMLAnchorElement | null => {
  const relSelector = rel === "prev"
    ? 'a[rel~="prev"], a[rel~="previous"], link[rel~="prev"]'
    : 'a[rel~="next"], link[rel~="next"]';
  // `querySelectorAll`, not `querySelector`. `<link rel="next">` lives in
  // `<head>` and therefore wins tree order, so on the normal configuration for
  // paginated content — both a machine-readable `<link>` and a visible `<a>` —
  // the first match was the `<link>`, the `instanceof` check failed, and the
  // unambiguous anchor sitting right there was abandoned for a text heuristic.
  for (const tagged of document.querySelectorAll(relSelector)) {
    if (tagged instanceof HTMLAnchorElement) return tagged;
  }

  const normalised = patterns.map((pattern) => pattern.trim().toLowerCase())
    .filter((pattern) => pattern.length > 0);

  const candidates: Array<{ element: HTMLAnchorElement; rank: number }> = [];
  for (const anchor of document.querySelectorAll("a[href]")) {
    if (!(anchor instanceof HTMLAnchorElement)) continue;
    const text = (anchor.textContent ?? "").trim().toLowerCase();
    const label = (anchor.getAttribute("aria-label") ?? "").trim()
      .toLowerCase();
    const haystack = `${text} ${label}`.trim();
    if (haystack.length === 0 || haystack.length > 60) continue;
    const rank = normalised.findIndex((pattern) =>
      haystack === pattern || haystack.includes(pattern)
    );
    if (rank !== -1) candidates.push({ element: anchor, rank });
  }

  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.element ?? null;
};

/** `gu` — drop one path segment. */
export const goUpUrl = (href: string, levels: number): string | null => {
  try {
    const url = new URL(href);
    // Stripping the fragment or the query is *free*: it is not a level. With
    // the early return keyed on `levels <= 1`, `2gu` on a URL with a fragment
    // removed the fragment and two path segments — three steps for a count of
    // two.
    const hadDecoration = url.hash.length > 0 || url.search.length > 0;
    url.hash = "";
    url.search = "";
    if (hadDecoration && levels <= 1) return url.href;

    const segments = url.pathname.split("/").filter((part) => part.length > 0);
    if (segments.length === 0) return null;
    const drop = hadDecoration ? levels - 1 : levels;
    if (drop <= 0) return url.href;
    segments.splice(Math.max(0, segments.length - drop));
    url.pathname = `/${segments.join("/")}${segments.length > 0 ? "/" : ""}`;
    return url.href;
  } catch {
    return null;
  }
};

const applyZoom = (app: AppContext, factor: number | null): void => {
  const origin = location.origin;
  const current = app.groups.session.current().zoomByOrigin[origin] ?? 1;
  const next = factor === null ? 1 : clamp(current * factor, 0.3, 5);
  // `zoom` on the root element, not real browser zoom: it does not affect the
  // URL bar, does not survive a manager change, and breaks `position: fixed` on
  // some sites. Off by default; §4.2.
  document.documentElement.style.zoom = next === 1 ? "" : String(next);
  app.runtime.runFork(Effect.ignore(
    app.groups.session.update((state) => ({
      ...state,
      zoomByOrigin: { ...state.zoomByOrigin, [origin]: next },
    })),
  ));
  app.hud.show(`Zoom ${Math.round(next * 100)}%`);
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

let muteObserver: MutationObserver | null = null;

const toggleMute = (app: AppContext): void => {
  const media = [...document.querySelectorAll("audio, video")]
    .filter((element): element is HTMLMediaElement =>
      element instanceof HTMLMediaElement
    );

  if (muteObserver !== null) {
    muteObserver.disconnect();
    muteObserver = null;
    for (const element of media) element.muted = false;
    app.hud.show("Unmuted");
    return;
  }

  for (const element of media) element.muted = true;
  // Only media *elements* are affected; WebAudio graphs keep playing. There is
  // no page-level mute available to a userscript.
  muteObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLMediaElement) node.muted = true;
        else if (node instanceof Element) {
          for (const nested of node.querySelectorAll("audio, video")) {
            if (nested instanceof HTMLMediaElement) nested.muted = true;
          }
        }
      }
    }
  });
  muteObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  app.hud.show("Muted media elements (WebAudio is unaffected)");
};

/** Stop the mute observer; called from `lifecycle.ts` on `pagehide`. */
export const teardownCommandObservers = (): void => {
  muteObserver?.disconnect();
  muteObserver = null;
};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const tierA = (
  name: string,
  group: CommandGroup,
  description: string,
  run: (invocation: CommandInvocation) => void,
  extra: Partial<CommandDef> = {},
): CommandDef => ({ name, group, description, tier: "A", run, ...extra });

const tierB = (
  name: string,
  group: CommandGroup,
  description: string,
  run: (invocation: CommandInvocation) => void,
  extra: Partial<CommandDef> = {},
): CommandDef => ({ name, group, description, tier: "B", run, ...extra });

/**
 * A command we cannot implement.
 *
 * The body is generated so that the refusal text and the help-dialog text can
 * never drift apart.
 */
const tierC = (
  name: string,
  group: CommandGroup,
  description: string,
  unavailableReason: string,
  nativeAlternative?: string,
): CommandDef => ({
  name,
  group,
  description,
  tier: "C",
  unavailableReason,
  nativeAlternative,
  run: ({ app }) => {
    app.hud.error(
      nativeAlternative === undefined
        ? `${description}: ${unavailableReason}`
        : `${description}: ${unavailableReason} — use ${nativeAlternative}`,
    );
  },
});

const hintCommand = (
  name: string,
  description: string,
  mode: HintMode,
  tier: "A" | "B" = "A",
): CommandDef => ({
  name,
  group: "hints",
  description,
  tier,
  run: ({ app }) => app.hints.activate(mode),
});

const NO_TAB_API = "a userscript has no tab-management API";

export const buildCommands = (): readonly CommandDef[] => [
  // --- Scrolling (Tier A) ------------------------------------------------
  tierA("scrollDown", "scrolling", "Scroll down", ({ app, count, event }) => {
    app.scroller.scrollBy("y", app.settings().scrollStepSize * count, event);
  }, { repeatable: true }),
  tierA("scrollUp", "scrolling", "Scroll up", ({ app, count, event }) => {
    app.scroller.scrollBy("y", -app.settings().scrollStepSize * count, event);
  }, { repeatable: true }),
  tierA("scrollLeft", "scrolling", "Scroll left", ({ app, count, event }) => {
    app.scroller.scrollBy("x", -app.settings().scrollStepSize * count, event);
  }, { repeatable: true }),
  tierA("scrollRight", "scrolling", "Scroll right", ({ app, count, event }) => {
    app.scroller.scrollBy("x", app.settings().scrollStepSize * count, event);
  }, { repeatable: true }),
  tierA(
    "scrollPageDown",
    "scrolling",
    "Scroll a half page down",
    ({ app, count, event }) => {
      app.scroller.scrollByViewport("y", 0.5 * count, event);
    },
    { repeatable: true },
  ),
  tierA(
    "scrollPageUp",
    "scrolling",
    "Scroll a half page up",
    ({ app, count, event }) => {
      app.scroller.scrollByViewport("y", -0.5 * count, event);
    },
    { repeatable: true },
  ),
  tierA(
    "scrollFullPageDown",
    "scrolling",
    "Scroll a full page down",
    ({ app, count, event }) => {
      app.scroller.scrollByViewport("y", 1 * count, event);
    },
    { repeatable: true },
  ),
  tierA(
    "scrollFullPageUp",
    "scrolling",
    "Scroll a full page up",
    ({ app, count, event }) => {
      app.scroller.scrollByViewport("y", -1 * count, event);
    },
    { repeatable: true },
  ),
  tierA(
    "scrollToTop",
    "scrolling",
    "Scroll to the top of the page",
    ({ app }) => {
      app.scroller.scrollTo("y", "start");
    },
  ),
  tierA(
    "scrollToBottom",
    "scrolling",
    "Scroll to the bottom of the page",
    ({ app }) => {
      app.scroller.scrollTo("y", "end");
    },
  ),
  tierA("scrollToLeft", "scrolling", "Scroll all the way left", ({ app }) => {
    app.scroller.scrollTo("x", "start");
  }),
  tierA("scrollToRight", "scrolling", "Scroll all the way right", ({ app }) => {
    app.scroller.scrollTo("x", "end");
  }),

  // --- Navigation (Tier A) -----------------------------------------------
  tierA("reload", "navigation", "Reload the page", () => location.reload()),
  tierC(
    "reloadHard",
    "navigation",
    "Reload, bypassing the cache",
    "a userscript cannot ask the browser to bypass its cache",
    "⇧⌘R",
  ),
  tierA("goBack", "navigation", "Go back in history", ({ count }) => {
    history.go(-count);
  }, { repeatable: true }),
  tierA("goForward", "navigation", "Go forward in history", ({ count }) => {
    history.go(count);
  }, { repeatable: true }),
  tierA("goUp", "navigation", "Go up the URL hierarchy", ({ app, count }) => {
    const url = goUpUrl(location.href, count);
    if (url === null) app.hud.error("Already at the root of this site");
    else location.assign(url);
  }, { repeatable: true }),
  tierA("goToRoot", "navigation", "Go to the site root", () => {
    location.assign(new URL("/", location.href).href);
  }),
  tierA("goPrevious", "navigation", 'Follow the "previous" link', ({ app }) => {
    const link = findRelLink(
      "prev",
      app.settings().previousPatterns.split(","),
    );
    if (link) link.click();
    else app.hud.error('No "previous" link found');
  }),
  tierA("goNext", "navigation", 'Follow the "next" link', ({ app }) => {
    const link = findRelLink("next", app.settings().nextPatterns.split(","));
    if (link) link.click();
    else app.hud.error('No "next" link found');
  }),

  // --- Hints -------------------------------------------------------------
  hintCommand("LinkHints.activateMode", "Open a link", "activate"),
  hintCommand(
    "LinkHints.activateModeToOpenInNewTab",
    "Open a link in a new background tab",
    "activate-new-tab-background",
    "B",
  ),
  hintCommand(
    "LinkHints.activateModeToOpenInNewForegroundTab",
    "Open a link in a new foreground tab",
    "activate-new-tab",
    "B",
  ),
  hintCommand(
    "LinkHints.activateModeToHover",
    "Hover over an element",
    "hover",
  ),
  hintCommand("LinkHints.activateModeToFocus", "Focus an element", "focus"),
  hintCommand(
    "LinkHints.activateModeToCopyLinkUrl",
    "Copy a link's URL",
    "copy-link-url",
    "B",
  ),
  hintCommand(
    "LinkHints.activateModeToCopyLinkText",
    "Copy a link's text",
    "copy-link-text",
    "B",
  ),
  hintCommand(
    "LinkHints.activateModeWithOmnibar",
    "Open a link with the omnibar",
    "open-with-omnibar",
    "B",
  ),
  tierC(
    "LinkHints.activateModeToDownloadLink",
    "hints",
    "Download a link",
    "WebKit ignores synthetic modifier-clicks, so a script cannot reach the download path",
    "right-click → Download Linked File",
  ),
  tierC(
    "LinkHints.activateModeToOpenIncognito",
    "hints",
    "Open a link in a private window",
    "there is no window-creation API for a userscript",
  ),

  // --- Find --------------------------------------------------------------
  tierA("enterFindMode", "find", "Search the page", ({ app }) => {
    app.find.enter({ backwards: false });
  }),
  tierA("performFind", "find", "Go to the next match", ({ app, count }) => {
    app.find.step(count);
  }, { repeatable: true }),
  tierA(
    "performBackwardsFind",
    "find",
    "Go to the previous match",
    ({ app, count }) => {
      app.find.step(-count);
    },
    { repeatable: true },
  ),
  tierA(
    "searchWordForwards",
    "find",
    "Search for the word under the cursor",
    ({ app }) => {
      app.find.searchWordUnderCursor(1);
    },
  ),
  tierA(
    "searchWordBackwards",
    "find",
    "Search backwards for the word under the cursor",
    ({ app }) => {
      app.find.searchWordUnderCursor(-1);
    },
  ),

  // --- Text --------------------------------------------------------------
  tierA("enterVisualMode", "text", "Enter visual mode", ({ app }) => {
    app.visual.enterVisual();
  }),
  tierA("enterVisualLineMode", "text", "Enter visual line mode", ({ app }) => {
    app.visual.enterVisualLine();
  }),
  tierA("enterCaretMode", "text", "Enter caret mode", ({ app }) => {
    app.visual.enterCaret();
  }),
  tierA("enterInsertMode", "text", "Enter insert mode", ({ app }) => {
    app.insert.enter();
  }),
  tierA("focusInput", "text", "Focus a text input", ({ app, count }) => {
    app.insert.focusInput(count);
  }, { repeatable: true }),

  // --- Clipboard ---------------------------------------------------------
  tierB("copyCurrentUrl", "clipboard", "Copy this page's URL", ({ app }) => {
    copyToClipboard(app, location.href, "URL");
  }),
  tierB(
    "copyCurrentTitle",
    "clipboard",
    "Copy this page's title",
    ({ app }) => {
      copyToClipboard(app, document.title, "title");
    },
  ),
  tierB(
    "openCopiedUrlInCurrentTab",
    "clipboard",
    "Open a pasted URL",
    ({ app }) => {
      openFromClipboard(app, false);
    },
  ),
  tierB(
    "openCopiedUrlInNewTab",
    "clipboard",
    "Open a pasted URL in a new tab",
    ({ app }) => {
      openFromClipboard(app, true);
    },
  ),

  // --- Tabs --------------------------------------------------------------
  tierB("createTab", "tabs", "Open a new tab", ({ app }) => {
    // `internal`: `newTabUrl` is the user's own setting, not page content, and
    // `about:blank` — its default — is outside the page-content allowlist.
    app.runtime.runFork(
      Tabs.use((tabs) =>
        tabs.open(app.settings().newTabUrl, {
          active: true,
          trust: "internal",
        })
      ).pipe(
        Effect.catch((error) => Effect.sync(() => app.hud.error(error.detail))),
      ),
    );
  }),
  tierB("removeTab", "tabs", "Close this tab", ({ app }) => {
    app.runtime.runSync(
      Effect.catch(
        Tabs.use((tabs) => tabs.closeCurrent),
        (error) =>
          Effect.sync(() => {
            app.hud.error(
              `${error.detail}${
                error.nativeAlternative
                  ? ` — use ${error.nativeAlternative}`
                  : ""
              }`,
            );
          }),
      ),
    );
  }),
  tierB(
    "toggleMuteTab",
    "tabs",
    "Mute or unmute media on this page",
    ({ app }) => {
      toggleMute(app);
    },
  ),
  tierB("zoomIn", "tabs", "Zoom in (CSS zoom)", ({ app }) => {
    if (!app.settings().enableCssZoom) {
      app.hud.error(
        "CSS zoom is disabled; enable it in Settings (it is not real browser zoom)",
      );
      return;
    }
    applyZoom(app, 1.1);
  }),
  tierB("zoomOut", "tabs", "Zoom out (CSS zoom)", ({ app }) => {
    if (!app.settings().enableCssZoom) {
      app.hud.error(
        "CSS zoom is disabled; enable it in Settings (it is not real browser zoom)",
      );
      return;
    }
    applyZoom(app, 1 / 1.1);
  }),
  tierB("zoomReset", "tabs", "Reset zoom", ({ app }) => {
    applyZoom(app, null);
  }),
  tierB(
    "toggleViewSource",
    "navigation",
    "View this page's source",
    ({ app }) => {
      // `internal`: we built this URL from `location.href`, and `view-source:`
      // is deliberately outside the set a page-supplied URL may use.
      app.runtime.runFork(
        Tabs.use((tabs) =>
          tabs.open(`view-source:${location.href}`, {
            active: true,
            trust: "internal",
          })
        ).pipe(
          Effect.catch(() =>
            Effect.sync(() =>
              app.hud.error(
                "Your userscript manager refused to open view-source:",
              )
            )
          ),
        ),
      );
    },
  ),

  tierC(
    "restoreTab",
    "tabs",
    "Reopen the last closed tab",
    "there is no session API",
    "⌘⇧T",
  ),
  tierC("nextTab", "tabs", "Go to the next tab", NO_TAB_API, "⌘⇧]"),
  tierC("previousTab", "tabs", "Go to the previous tab", NO_TAB_API, "⌘⇧["),
  tierC("firstTab", "tabs", "Go to the first tab", NO_TAB_API, "⌘1"),
  tierC("lastTab", "tabs", "Go to the last tab", NO_TAB_API, "⌘9"),
  tierC(
    "visitPreviousTab",
    "tabs",
    "Go to the previously visited tab",
    NO_TAB_API,
  ),
  tierC(
    "moveTabLeft",
    "tabs",
    "Move this tab left",
    NO_TAB_API,
    "drag the tab",
  ),
  tierC(
    "moveTabRight",
    "tabs",
    "Move this tab right",
    NO_TAB_API,
    "drag the tab",
  ),
  tierC(
    "moveTabToNewWindow",
    "tabs",
    "Move this tab to a new window",
    NO_TAB_API,
    "drag the tab out",
  ),
  tierC(
    "togglePinTab",
    "tabs",
    "Pin or unpin this tab",
    NO_TAB_API,
    "right-click the tab",
  ),
  tierC(
    "duplicateTab",
    "tabs",
    "Duplicate this tab",
    NO_TAB_API,
    "right-click the tab",
  ),
  tierC(
    "closeTabsOnLeft",
    "tabs",
    "Close tabs to the left",
    NO_TAB_API,
    "right-click the tab",
  ),
  tierC(
    "closeTabsOnRight",
    "tabs",
    "Close tabs to the right",
    NO_TAB_API,
    "right-click the tab",
  ),
  tierC(
    "closeOtherTabs",
    "tabs",
    "Close all other tabs",
    NO_TAB_API,
    "right-click the tab",
  ),

  // --- Marks -------------------------------------------------------------
  tierA("Marks.activateCreateMode", "marks", "Set a mark", ({ app }) => {
    captureNextKey(app, "Set mark:", (key) => app.marks.setLocal(key));
  }),
  tierA("Marks.activateGotoMode", "marks", "Jump to a mark", ({ app }) => {
    captureNextKey(app, "Go to mark:", (key) => app.marks.jumpLocal(key));
  }),

  // --- Omnibar -----------------------------------------------------------
  tierB("Vomnibar.activate", "navigation", "Open the omnibar", ({ app }) => {
    app.omnibar.open("url");
  }),
  tierB(
    "Vomnibar.activateInNewTab",
    "navigation",
    "Open the omnibar (new tab)",
    ({ app }) => {
      app.omnibar.open("url");
    },
  ),
  tierB(
    "Vomnibar.activateCommands",
    "misc",
    "Open the command palette",
    ({ app }) => {
      app.omnibar.open("command");
    },
  ),
  tierB(
    "Vomnibar.activateSearch",
    "navigation",
    "Search with a custom engine",
    ({ app }) => {
      app.omnibar.open("search");
    },
  ),
  tierC(
    "Vomnibar.activateBookmarks",
    "navigation",
    "Search bookmarks",
    "there is no bookmarks API for a userscript",
    "⌥⌘B",
  ),
  tierB(
    "clear-history",
    "misc",
    "Erase the local history index",
    ({ app }) => {
      void app.omnibar.clearHistory().then(
        () => app.hud.show("Local history index erased"),
        (cause: unknown) => {
          app.hud.error(
            `Could not erase the history index: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        },
      );
    },
    { topFrameOnly: true },
  ),

  // --- Frames ------------------------------------------------------------
  tierB("nextFrame", "navigation", "Focus the next frame", ({ app }) => {
    app.frames.focusFrame(1);
  }),
  tierB("mainFrame", "navigation", "Focus the main frame", ({ app }) => {
    app.frames.focusFrame(-1);
  }),

  // --- Misc --------------------------------------------------------------
  tierA(
    "showHelp",
    "misc",
    "Show the help dialog",
    ({ app }) => app.showHelp(),
  ),
  tierA(
    "showSettings",
    "misc",
    "Open settings",
    ({ app }) => app.showSettings(),
  ),
  tierA(
    "passNextKey",
    "misc",
    "Pass the next key to the page",
    ({ app, count }) => {
      app.hud.show(
        `Passing the next ${count === 1 ? "key" : `${count} keys`} to the page`,
      );
      app.passNextKey(count);
    },
    { repeatable: true, advanced: true },
  ),
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

class Registry implements CommandRegistry {
  readonly #byName: ReadonlyMap<string, CommandDef>;
  readonly #all: readonly CommandDef[];

  constructor(commands: readonly CommandDef[]) {
    this.#all = commands;
    this.#byName = new Map(commands.map((command) => [command.name, command]));
  }

  get(name: string): CommandDef | undefined {
    return this.#byName.get(name);
  }

  all(): readonly CommandDef[] {
    return this.#all;
  }

  byGroup(): ReadonlyMap<CommandGroup, readonly CommandDef[]> {
    const out = new Map<CommandGroup, CommandDef[]>();
    for (const command of this.#all) {
      const list = out.get(command.group) ?? [];
      list.push(command);
      out.set(command.group, list);
    }
    return out;
  }

  run(name: string, invocation: CommandInvocation): void {
    const command = this.#byName.get(name);
    if (!command) {
      invocation.app.hud.error(`Unknown command "${name}"`);
      return;
    }
    try {
      command.run(invocation);
    } catch (cause) {
      invocation.app.hud.error(
        `${name} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
}

export const createCommandRegistry = (): CommandRegistry =>
  new Registry(buildCommands());

export const commandNames = (): ReadonlySet<string> =>
  new Set(buildCommands().map((command) => command.name));

// ---------------------------------------------------------------------------
// Default mappings
// ---------------------------------------------------------------------------

/**
 * Vimium's default bindings, minus those whose commands are Tier C.
 *
 * Tier C commands are still *bound* — pressing `J` should explain why tab
 * switching is impossible rather than doing nothing, which is the entire point
 * of §4.3.
 */
export const DEFAULT_MAPPINGS = `
# Scrolling
map j scrollDown
map k scrollUp
map h scrollLeft
map l scrollRight
map <down> scrollDown
map <up> scrollUp
map <left> scrollLeft
map <right> scrollRight
map gg scrollToTop
map G scrollToBottom
map zH scrollToLeft
map zL scrollToRight
map 0 scrollToLeft
map $ scrollToRight
map d scrollPageDown
map u scrollPageUp
map <c-d> scrollPageDown
map <c-u> scrollPageUp
map <c-f> scrollFullPageDown
map <c-b> scrollFullPageUp
map <space> scrollFullPageDown
map <s-space> scrollFullPageUp

# Navigation
map r reload
map R reloadHard
map H goBack
map L goForward
map gu goUp
map gU goToRoot
map [[ goPrevious
map ]] goNext
map gs toggleViewSource
map gf nextFrame
map gF mainFrame

# Link hints
map f LinkHints.activateMode
map F LinkHints.activateModeToOpenInNewTab
map <a-f> LinkHints.activateModeToOpenInNewForegroundTab
map yf LinkHints.activateModeToCopyLinkUrl
map yt LinkHints.activateModeToCopyLinkText
map <a-h> LinkHints.activateModeToHover
map <a-o> LinkHints.activateModeWithOmnibar
map gd LinkHints.activateModeToDownloadLink
map gI LinkHints.activateModeToOpenIncognito

# Find
map / enterFindMode
map n performFind
map N performBackwardsFind
map * searchWordForwards
map # searchWordBackwards

# Text
map i enterInsertMode
map v enterVisualMode
map V enterVisualLineMode
map c enterCaretMode
map gi focusInput

# Clipboard
map yy copyCurrentUrl
map yT copyCurrentTitle
map p openCopiedUrlInCurrentTab
map P openCopiedUrlInNewTab

# Omnibar
map o Vomnibar.activate
map O Vomnibar.activateInNewTab
map : Vomnibar.activateCommands
map s Vomnibar.activateSearch
map b Vomnibar.activateBookmarks

# Marks
map m Marks.activateCreateMode
map \` Marks.activateGotoMode

# Tabs
map t createTab
map x removeTab
map <a-m> toggleMuteTab
map zi zoomIn
map zo zoomOut
map z0 zoomReset
map X restoreTab
map J previousTab
map K nextTab
map gT previousTab
map gt nextTab
map g0 firstTab
map g$ lastTab
map ^ visitPreviousTab
map W moveTabToNewWindow
map << moveTabLeft
map >> moveTabRight
map <a-p> togglePinTab
map yd duplicateTab

# Misc
map ? showHelp
`;
