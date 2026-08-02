/**
 * Stage 1: build the application.
 *
 * Reached lazily — on the first interesting keystroke, on a wake message from
 * the coordinator, or (top frame only) shortly after load. Everything expensive
 * lives here: storage hydration, the UI host, the key trie, and every feature.
 *
 * Nothing in this function may throw. A userscript that breaks a page is worse
 * than a userscript that does not work, so every fallible step degrades to a
 * documented default and, where the user would notice, a HUD message (goal G3).
 */

import {
  type Capabilities,
  degradationWarnings,
  probeCapabilities,
} from "~/platform/capabilities.ts";
import { detectGmSurface, selectValueBackend } from "~/platform/gm.ts";
import { Effect } from "effect";
import { type AppRuntime, makeAppRuntime } from "./runtime.ts";
import { STORAGE_PREFIX, ValueStore } from "~/platform/storage.ts";
import {
  findHistoryGroup,
  historyGroup,
  marksGroup,
  sessionGroup,
  type Settings,
  settingsGroup,
} from "~/settings/schema.ts";

import { HandlerStack } from "~/core/handler-stack.ts";
import type { ModeHost } from "~/core/mode.ts";
import { exitAllModes } from "~/core/mode.ts";
import { type CompiledMappings, compileMappings } from "~/core/mappings.ts";
import {
  commandNames,
  createCommandRegistry,
  DEFAULT_MAPPINGS,
  teardownCommandObservers,
} from "~/core/commands.ts";
import { NormalMode } from "~/core/key-handler.ts";
import {
  type EffectiveRule,
  ExclusionSet,
  FULLY_ENABLED,
} from "~/core/exclusions.ts";
import type { AppContext, StorageGroups } from "~/core/context.ts";

import { createUiRoot } from "~/ui/root.ts";
import { createHud } from "~/ui/hud.ts";
import { createDialogs } from "~/ui/dialog.ts";

import { createScroller } from "~/features/scroller.ts";
import { createHints } from "~/features/hints/index.ts";
import { createFind } from "~/features/find/index.ts";
import { createVisual } from "~/features/visual/index.ts";
import { createMarks } from "~/features/marks.ts";
import { createInsert, mediaPlayerHasFocus } from "~/features/insert.ts";
import { createOmnibar } from "~/features/omnibar/index.ts";
import { createFrameLink } from "~/frames/index.ts";

import { watchLifecycle } from "./lifecycle.ts";
import { isTopFrame, type Stage0, wakeSubframes } from "./stage0.ts";

export interface Stage1 {
  readonly app: AppContext;
  dispose(): void;
}

export const startStage1 = async (stage0: Stage0): Promise<Stage1> => {
  const gm = detectGmSurface();
  const caps: Capabilities = probeCapabilities(gm);

  const store = new ValueStore(selectValueBackend(gm, STORAGE_PREFIX));

  // Registered *before* hydration. It used to be attached forty lines later,
  // which is why the read failures below were invisible: every one of them was
  // reported into an empty listener set and then papered over with defaults.
  const startupIssues: string[] = [];
  let reportIssue: (message: string) => void = (message) => {
    startupIssues.push(message);
  };
  store.onIssue((issue) => {
    reportIssue(
      `Stored ${issue.group} could not be read (${issue.reason}); using defaults. ` +
        "Open Settings to review.",
    );
  });

  const groups: StorageGroups = {
    settings: store.group(settingsGroup),
    marks: store.group(marksGroup),
    findHistory: store.group(findHistoryGroup),
    history: store.group(historyGroup),
    session: store.group(sessionGroup),
  };

  // Every group, not a subset. `update()` is read-modify-write against
  // `current() = #cached ?? defaults()`, so a group that was never hydrated has
  // no `#cached` — and the first write to it silently replaces the user's
  // entire persisted value with the defaults plus one change. The frecency
  // index and find history lost everything on every page load.
  //
  // Driven off the store's own registry rather than a hand-written list, so
  // this class of bug is structurally impossible rather than caught by review.
  // One runtime per frame, built here rather than at module scope: a frame
  // that never sees a keystroke must not pay for it.
  const runtime: AppRuntime = makeAppRuntime();

  // Every group, not a subset — see the note above.
  await runtime.runPromise(store.hydrateAll());

  let settings: Settings = groups.settings.current();
  let mappings = compile(settings, caps);
  let exclusion: EffectiveRule = FULLY_ENABLED;

  const handlerStack = new HandlerStack();
  const ui = createUiRoot({
    caps,
    followPageColorScheme: () => settings.followPageColorScheme,
  });
  const hud = createHud({ root: ui, hidden: () => settings.hideHud });

  const modeHost: ModeHost = {
    handlerStack,
    setIndicator: (indicator) => hud.setIndicator(indicator),
  };

  handlerStack.onHandlerError((message, cause) => {
    hud.error(message);
    console.error(`[vimium-webkit] ${message}`, cause);
  });

  // The HUD exists now, so issues can be shown rather than collected.
  reportIssue = (message) => hud.error(message);
  for (const message of startupIssues.splice(0)) hud.error(message);

  const isTop = isTopFrame();
  const exclusions = () => new ExclusionSet(settings.exclusionRules);

  // Declared before `app` so features can close over it; assigned immediately
  // after, because several of them need `app` in turn.
  let appRef: AppContext | null = null;
  const app = (): AppContext => {
    if (appRef === null) {
      throw new Error("stage1: context used before assembly");
    }
    return appRef;
  };

  const lazy = <T>(build: () => T): () => T => {
    let value: T | null = null;
    return () => (value ??= build());
  };

  const scroller = createScroller({
    stepSize: () => settings.scrollStepSize,
    smooth: () => settings.smoothScroll,
  });

  // Features are constructed lazily and memoised: a subframe that only ever
  // answers hint requests should never build a find engine or an omnibar.
  const hints = lazy(() => createHints(app()));
  const find = lazy(() => createFind(app()));
  const visual = lazy(() => createVisual(app()));
  const marks = lazy(() => createMarks(app()));
  const insert = lazy(() => createInsert(app(), modeHost));
  const omnibar = lazy(() => createOmnibar(app()));

  const frames = createFrameLink({
    isTop,
    resolveExclusion: () => {
      const rule = exclusions().match(location.href);
      return { enabled: rule.enabled, passKeys: rule.passKeys };
    },
    localHints: {
      collectLocal: (mode) => hints().collectLocal(mode),
      activateLocal: (index, mode) => hints().activateLocal(index, mode),
      handleRemoteKey: (notation) => hints().handleRemoteKey(notation),
      beginRemoteSession: (remote) => hints().beginRemoteSession(remote),
    },
    onTopFrameUpdate: (pushedExclusion) => {
      // Settings are never accepted over the wire. They used to be, which made
      // the protocol a route for a CSS string, a search template and a mapping
      // source into every frame on the page — and made the handshake an
      // exfiltration channel for the user's exclusion patterns. This is a
      // prompt to re-read our own storage, not a source of truth.
      void reloadSettings();

      // The top frame resolves exclusions from its own URL, so a subframe only
      // learns the verdict when it is welcomed. Until this ran, a subframe that
      // booted ahead of its welcome stayed fully enabled on an excluded page
      // for the life of the document (FRM-04).
      if (!isTop) {
        exclusion = {
          enabled: pushedExclusion.enabled,
          passKeys: pushedExclusion.passKeys,
        };
        applyExclusion();
      }
    },
    onTakeFocus: () => hud.show("Frame focused"),
  });

  /**
   * Re-read settings from *our own* storage and recompile everything derived.
   *
   * Split out of `refresh()` because the two callers differ in exactly one
   * respect: `refresh()` also re-resolves the exclusion, which for a subframe
   * means a round trip to the top frame. When the top frame has just told us
   * the exclusion, asking it again would be a redundant hop on the settings
   * path.
   */
  const reloadSettings = async (): Promise<void> => {
    await runtime.runPromise(groups.settings.hydrate());
    settings = groups.settings.current();
    mappings = compile(settings, caps);
    normalMode.recompiled();
    ui.syncColorScheme();
  };

  const commands = createCommandRegistry();

  const dialogs = createDialogs({
    root: ui,
    get app() {
      return app();
    },
    mappings: () => mappings,
    saveSettings: async (next) => {
      settings = next;
      mappings = compile(settings, caps);
      normalMode.recompiled();
      ui.syncColorScheme();
      await runtime.runPromise(Effect.ignore(groups.settings.write(next)));
      frames.pushSettings();
    },
    saveMappings: async (source) => {
      settings = { ...settings, keyMappings: source };
      mappings = compile(settings, caps);
      normalMode.recompiled();
      await runtime.runPromise(
        Effect.ignore(groups.settings.write(settings)),
      );
    },
  });

  const normalMode = new NormalMode(modeHost, {
    mappings: () => mappings,
    exclusion: () => exclusion,
    ignoreKeyboardLayout: () => settings.ignoreKeyboardLayout,
    mediaKeysBelongToPage: () =>
      settings.passMediaKeys && mediaPlayerHasFocus(),
    showPending: (keys) => hud.setIndicator(keys),
    run: (name, options, count, event) => {
      // Woken lazily rather than eagerly: subframes must not be forced through
      // Stage 1 unless a cross-frame feature actually needs them.
      if (name.startsWith("LinkHints.")) wakeSubframes();
      commands.run(name, { count, options, event, app: app() });
    },
  });

  appRef = {
    runtime,
    caps,
    gm,
    handlerStack,
    modeHost,
    store,
    groups,
    settings: () => settings,
    ui,
    hud,
    commands,
    get scroller() {
      return scroller;
    },
    get hints() {
      return hints();
    },
    get find() {
      return find();
    },
    get visual() {
      return visual();
    },
    get marks() {
      return marks();
    },
    get insert() {
      return insert();
    },
    get omnibar() {
      return omnibar();
    },
    frames,
    refresh: async () => {
      await reloadSettings();
      exclusion = await resolveExclusion();
      applyExclusion();
    },
    passNextKey: (count) => normalMode.passNextKey(count),
    showHelp: () => dialogs.showHelp(),
    showSettings: () => dialogs.showSettings(),
  };

  const resolveExclusion = async (): Promise<EffectiveRule> => {
    if (isTop) return exclusions().match(location.href);
    // Upstream evaluates exclusions against the *top* frame's URL via
    // `sender.tab.url`. Matching that matters: otherwise an excluded page would
    // still have us live inside its third-party iframes.
    const remote = await frames.effectiveExclusion();
    return { enabled: remote.enabled, passKeys: remote.passKeys };
  };

  const applyExclusion = (): void => {
    if (exclusion.enabled) {
      normalMode.enter();
      // `ensureEntered`, not just construction: the feature object is memoised,
      // so after `exitAllModes` on a soft navigation the memoised value is an
      // *exited* mode and constructing it again is exactly what memoisation
      // prevents (CORE-01).
      insert().ensureEntered();
    } else {
      exitAllModes("navigation");
      hud.setIndicator(null);
    }
  };

  exclusion = await resolveExclusion();
  applyExclusion();

  // Before any listener is attached: insert mode otherwise only learns about
  // focus from live events, and by the time Stage 1 runs the page has long
  // since autofocused its search box (OSU-02).
  if (exclusion.enabled) insert().seedFromFocus();

  if (settings.grabBackFocus && isTop) {
    insert().grabBackFocus(stage0.hasTypedIntoEditable());
  }
  if (isTop) omnibar().noteVisit();

  // Hand the keyboard over and replay whatever the user typed while we booted.
  stage0.adopt((event) => {
    if (event.type === "keydown") {
      scroller.noteKeydown(event);
      handlerStack.bubbleEvent("keydown", event);
    } else {
      scroller.noteKeyup(event);
      handlerStack.bubbleEvent("keyup", event);
    }
  });

  for (const event of stage0.drainBuffer()) {
    handlerStack.bubbleEvent("keydown", event);
  }

  // Events the handler stack needs but Stage 0 does not listen for. Registered
  // here rather than in Stage 0 because they are only meaningful once modes
  // exist, and `focus`/`blur` in particular fire constantly on busy pages.
  const forward = (name: "click" | "focus" | "blur"): () => void => {
    const listener = (event: Event): void => {
      if (name === "click") {
        if (event instanceof MouseEvent) {
          handlerStack.bubbleEvent("click", event);
        }
      } else if (event instanceof FocusEvent) {
        handlerStack.bubbleEvent(name, event);
      }
    };
    globalThis.addEventListener(name, listener, true);
    return () => globalThis.removeEventListener(name, listener, true);
  };
  const detach = [forward("click"), forward("focus"), forward("blur")];

  // A press whose release we will never see — Cmd-Tab away mid-keystroke is the
  // everyday case — leaves normal mode expecting a `keyup` that never comes,
  // and the *next* release of that physical key is then swallowed from a page
  // that was entitled to it.
  const forgetSuppressed = (): void => normalMode.forgetSuppressed();
  globalThis.addEventListener("blur", forgetSuppressed);
  detach.push(() => globalThis.removeEventListener("blur", forgetSuppressed));

  const lifecycle = watchLifecycle({
    onUrlChange: () => {
      exitAllModes("navigation");
      // The observer is watching media elements that no longer exist, and a
      // soft navigation is the point at which "muted" stops meaning anything.
      teardownCommandObservers();
      void app().refresh();
      if (isTop) omnibar().noteVisit();
    },
    onRestore: () => {
      stage0.rearm();
      void app().refresh();
    },
    onLeave: () => teardownCommandObservers(),
    // Marks debounce 100 ms, settings 250 ms and the history index 2 s; a
    // navigation inside any of those windows used to discard the write.
    onPersist: () => {
      runtime.runFork(store.flushAll());
      normalMode.forgetSuppressed();
    },
    onVisible: () => {
      // The portable substitute for `GM_addValueChangeListener`, which quoid
      // and Stay do not implement: re-read shared storage when the tab is
      // brought forward, so a settings change in another tab lands.
      if (!store.supportsWatch) void app().refresh();
    },
  });

  for (const warning of degradationWarnings(caps)) hud.error(warning);

  return {
    app: app(),
    dispose: () => {
      lifecycle.dispose();
      for (const off of detach) off();
      teardownCommandObservers();
      // Anything still inside a debounce window would otherwise be discarded.
      runtime.runFork(store.flushAll());
      exitAllModes("navigation");
      frames.dispose();
      scroller.dispose();
      normalMode.forgetSuppressed();
      ui.destroy();
      handlerStack.reset();
      // Last: closes the runtime's scope, releasing anything acquired through
      // it. Nothing above may need the runtime after this point.
      void runtime.dispose();
    },
  };
};

/**
 * Compile the default mappings, then the user's on top.
 *
 * Concatenating rather than replacing means `unmap j` works against the
 * defaults, which is what every Vimium user's configuration assumes — at the
 * cost of a line-number offset, which `lineOffset` corrects so that a
 * diagnostic the user sees next to their own text names their own line.
 */
const DEFAULT_MAPPING_LINES = `${DEFAULT_MAPPINGS}\n`.split("\n").length - 1;

const compile = (settings: Settings, caps: Capabilities): CompiledMappings => {
  const source = `${DEFAULT_MAPPINGS}\n${settings.keyMappings}`;
  return compileMappings(source, {
    knownCommands: commandNames(),
    // Only reject outright on the engine where the binding genuinely cannot
    // fire; elsewhere the same configuration is legitimate.
    rejectReservedShortcuts: caps.webkitLike,
    lineOffset: DEFAULT_MAPPING_LINES,
  });
};
