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
import { STORAGE_PREFIX, ValueStore } from "~/platform/storage.ts";
import {
  defaultSettings,
  findHistoryGroup,
  historyGroup,
  marksGroup,
  sessionGroup,
  type Settings,
  settingsGroup,
  settingsSchema,
} from "~/settings/schema.ts";

import { HandlerStack } from "~/core/handler-stack.ts";
import type { ModeHost } from "~/core/mode.ts";
import { exitAllModes } from "~/core/mode.ts";
import { type CompiledMappings, compileMappings } from "~/core/mappings.ts";
import {
  commandNames,
  createCommandRegistry,
  DEFAULT_MAPPINGS,
  passNextKeyRequest,
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
import { createInsert } from "~/features/insert.ts";
import { createOmnibar } from "~/features/omnibar/index.ts";
import { createFrameLink } from "~/frames/index.ts";

import { watchLifecycle } from "./lifecycle.ts";
import { type Stage0, wakeSubframes } from "./stage0.ts";

export interface Stage1 {
  readonly app: AppContext;
  dispose(): void;
}

export const startStage1 = async (stage0: Stage0): Promise<Stage1> => {
  const gm = detectGmSurface();
  const caps: Capabilities = probeCapabilities(gm);

  const store = new ValueStore(selectValueBackend(gm, STORAGE_PREFIX));
  const groups: StorageGroups = {
    settings: store.group(settingsGroup),
    marks: store.group(marksGroup),
    findHistory: store.group(findHistoryGroup),
    history: store.group(historyGroup),
    session: store.group(sessionGroup),
  };

  // Hydrate before anything reads settings. `hydrate()` never rejects: a
  // corrupt group falls back to defaults and reports through `store.onIssue`.
  await Promise.all([
    groups.settings.hydrate(),
    groups.marks.hydrate(),
    groups.session.hydrate(),
  ]);

  let settings: Settings = groups.settings.current();
  let mappings = compile(settings, caps);
  let exclusion: EffectiveRule = FULLY_ENABLED;

  const handlerStack = new HandlerStack();
  const ui = createUiRoot({ caps });
  const hud = createHud({ root: ui, hidden: () => settings.hideHud });

  const modeHost: ModeHost = {
    handlerStack,
    setIndicator: (indicator) => hud.setIndicator(indicator),
  };

  handlerStack.onHandlerError((message, cause) => {
    hud.error(message);
    console.error(`[vimium-webkit] ${message}`, cause);
  });

  store.onIssue((issue) => {
    hud.error(
      `Stored ${issue.group} could not be read (${issue.kind}); using defaults. ` +
        "Open Settings to review.",
    );
  });

  const isTop = globalThis.top === globalThis.self;
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
    },
    currentSettings: () => settings,
    onSettingsPushed: (pushed) => {
      // Re-validated rather than trusted: it arrived over `postMessage`, and a
      // page can post anything that looks like our protocol (§6.5).
      const parsed = settingsSchema.safeParse(pushed);
      if (!parsed.success) return;
      settings = parsed.data;
      mappings = compile(settings, caps);
      normalMode.recompiled();
    },
    onTakeFocus: () => hud.show("Frame focused"),
  });

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
      await groups.settings.write(next);
      frames.pushSettings();
    },
    saveMappings: async (source) => {
      settings = { ...settings, keyMappings: source };
      mappings = compile(settings, caps);
      normalMode.recompiled();
      await groups.settings.write(settings);
    },
  });

  const normalMode = new NormalMode(modeHost, {
    mappings: () => mappings,
    exclusion: () => exclusion,
    ignoreKeyboardLayout: () => settings.ignoreKeyboardLayout,
    showPending: (keys) => hud.setIndicator(keys),
    run: (name, options, count, event) => {
      // Woken lazily rather than eagerly: subframes must not be forced through
      // Stage 1 unless a cross-frame feature actually needs them.
      if (name.startsWith("LinkHints.")) wakeSubframes();
      commands.run(name, { count, options, event, app: app() });
      if (passNextKeyRequest.count > 0) {
        normalMode.passNextKey(passNextKeyRequest.count);
        passNextKeyRequest.count = 0;
      }
    },
  });

  appRef = {
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
      await groups.settings.hydrate();
      settings = groups.settings.current();
      mappings = compile(settings, caps);
      normalMode.recompiled();
      exclusion = await resolveExclusion();
      applyExclusion();
    },
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
      insert();
    } else {
      exitAllModes("navigation");
      hud.setIndicator(null);
    }
  };

  exclusion = await resolveExclusion();
  applyExclusion();

  if (settings.grabBackFocus && isTop) insert().grabBackFocus();
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

  const lifecycle = watchLifecycle({
    onUrlChange: () => {
      exitAllModes("navigation");
      void app().refresh();
      if (isTop) omnibar().noteVisit();
    },
    onRestore: () => {
      stage0.rearm();
      void app().refresh();
    },
    onLeave: () => teardownCommandObservers(),
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
      exitAllModes("navigation");
      frames.dispose();
      ui.destroy();
      handlerStack.reset();
    },
  };
};

/**
 * Compile the default mappings, then the user's on top.
 *
 * Concatenating rather than replacing means `unmap j` works against the
 * defaults, which is what every Vimium user's configuration assumes.
 */
const compile = (settings: Settings, caps: Capabilities): CompiledMappings => {
  const source = `${DEFAULT_MAPPINGS}\n${settings.keyMappings}`;
  return compileMappings(source, {
    knownCommands: commandNames(),
    // Only reject outright on the engine where the binding genuinely cannot
    // fire; elsewhere the same configuration is legitimate.
    rejectReservedShortcuts: caps.webkitLike,
  });
};

/** Exported for tests: the settings a fresh install starts from. */
export const initialSettings = defaultSettings;
