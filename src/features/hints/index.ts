/**
 * The link-hints subsystem (IMPLEMENTATION_PLAN.md §6.8).
 *
 * `createHints` owns the session lifecycle: detect, optionally collect from
 * sibling frames, then hand a globally-ordered entry list to a `HintMode`.
 *
 * The ordering contract is the load-bearing part of cross-frame hints. Every
 * frame sorts the merged descriptor set by `frameId` then `localIndex`, so each
 * frame independently derives *the same* hint-string assignment with no further
 * coordination. Get that wrong and two frames disagree about what `sa` means.
 */

import type {
  AppContext,
  HintMode as HintModeKind,
  HintsApi,
  RemoteHintDescriptor,
} from "~/core/context.ts";
import type { RemoteHintSession } from "~/frames/index.ts";
import { AbortedError, withDeadline } from "~/platform/scheduler.ts";
import { detectHints, type LocalHint } from "./detect.ts";
import {
  activateLocalHint,
  type HintEntry,
  HintMode,
  KeyBufferMode,
  modeRequiresHref,
  releaseHover,
} from "./mode.ts";
import { hintCss } from "./styles.ts";

export type { LocalHint } from "./detect.ts";
export { HINT_CSS, hintCss } from "./styles.ts";

/**
 * The hints surface, plus the hooks the cross-frame coordinator needs.
 *
 * `FrameLinkApi` can only ask *this* frame for descriptors and tell it to
 * activate one of its own hints; those two operations have to live somewhere,
 * and putting them here keeps the element references from ever crossing a frame
 * boundary.
 */
export interface LocalHintsApi extends HintsApi {
  /** Answer a `COLLECT_HINTS` request from the coordinator. */
  collectLocal(mode: HintModeKind): Promise<readonly RemoteHintDescriptor[]>;
  /** Act on one of this frame's own hints, at the coordinator's request. */
  activateLocal(localIndex: number, mode: HintModeKind): void;
  /** A keystroke that happened in another frame during a live session. */
  handleRemoteKey(notation: string): void;
  /**
   * Join a round another frame started, so this frame draws its own markers.
   *
   * Without this, a cross-frame round put markers only on the origin frame's
   * links: everything below the hook was already in place, and the hook itself
   * had no implementation and no call site, which made cross-frame hints dead
   * in the default (alphabet) mode (FRM-01).
   */
  beginRemoteSession(remote: RemoteHintSession): void;
}

/** Vimium's number, and for the same reason: a hung frame must not deadlock us. */
const COLLECT_DEADLINE_MS = 3000;

/**
 * How long a hint round keeps authorising a remote activation.
 *
 * Matches the coordinator's own round TTL: filter mode with
 * `waitForEnterForFilteredHints` can legitimately stay open while the user
 * reads the page, so this bounds a capability rather than a UX interaction.
 */
const ROUND_TTL_MS = 120_000;

const descriptorsFor = (
  frameId: string,
  hints: readonly LocalHint[],
): readonly RemoteHintDescriptor[] =>
  hints.map((hint, localIndex) => ({
    frameId,
    localIndex,
    linkText: hint.linkText,
    secondary: hint.secondary,
  }));

/**
 * Total order over descriptors.
 *
 * Frame ids are compared as strings, which is fine as long as every frame uses
 * the same comparison — determinism matters here, not aesthetics.
 */
const byFrameThenIndex = (
  a: RemoteHintDescriptor,
  b: RemoteHintDescriptor,
): number =>
  a.frameId === b.frameId
    ? a.localIndex - b.localIndex
    : (a.frameId < b.frameId ? -1 : 1);

interface Session {
  readonly kind: HintModeKind;
  readonly controller: AbortController;
  buffer: KeyBufferMode | null;
  mode: HintMode | null;
}

export const createHints = (app: AppContext): LocalHintsApi => {
  let session: Session | null = null;
  let installedCss: string | null = null;
  /** Kept so a remote `activateHint` can find the element again. */
  let lastLocal: readonly LocalHint[] = [];
  /**
   * When the round that produced `lastLocal` stops authorising activation.
   *
   * `activateLocal` used to index straight into `lastLocal` with no session
   * check, and `lastLocal` is populated by *any* detection pass — including one
   * triggered by a `COLLECT_HINTS` for a round the user never started. Bounding
   * it by time rather than by "is a mode live" is deliberate: the origin frame
   * tears its own mode down before it dispatches, so requiring a live session
   * here would refuse the legitimate activation it is meant to protect.
   */
  let roundOpenUntil = 0;
  let warnedUnreachable = false;

  const ensureStyles = (): void => {
    const css = hintCss(app.settings().userDefinedLinkHintCss);
    if (css === installedCss) return;
    // CSSOM only. A `<style>` element here would be subject to the page's
    // `style-src` and silently blocked on any CSP-hardened site. Keyed rather
    // than appended: the user CSS can change, and every past version would
    // otherwise stay adopted alongside the current one.
    app.ui.setStyle("hints", css);
    installedCss = css;
  };

  const detect = async (
    kind: HintModeKind,
    signal: AbortSignal,
  ): Promise<readonly LocalHint[]> => {
    const result = await detectHints({
      caps: app.caps,
      viewport: app.ui.viewport(),
      requireHref: modeRequiresHref(kind),
      signal,
      overlayHost: app.ui.shadow.host,
    });

    if (result.unreachableHosts > 0 && !warnedUnreachable) {
      warnedUnreachable = true;
      // Closed shadow roots return `null` from `element.shadowRoot` by design,
      // and patching `attachShadow` needs a reliable `document-start` that
      // WebKit does not give a userscript. Telling the user beats a silent gap.
      app.hud.show(
        "Some elements on this page are not reachable (closed shadow DOM).",
      );
    }

    lastLocal = result.hints;
    return result.hints;
  };

  /** Merge our own hints with the other frames', in a globally stable order. */
  const merge = (
    local: readonly LocalHint[],
    remote: readonly RemoteHintDescriptor[],
  ): readonly HintEntry[] => {
    const own = descriptorsFor(app.frames.frameId, local);
    // Drop any echo of our own descriptors: upstream measured stripping them
    // from each reply as a 150% speedup, and we must not double-count.
    const others = remote.filter(
      (descriptor) => descriptor.frameId !== app.frames.frameId,
    );

    return [...own, ...others].sort(byFrameThenIndex).map((descriptor) => ({
      frameId: descriptor.frameId,
      localIndex: descriptor.localIndex,
      linkText: descriptor.linkText,
      secondary: descriptor.secondary,
      hint: descriptor.frameId === app.frames.frameId
        ? lookup(local, descriptor.localIndex)
        : null,
    }));
  };

  const lookup = (
    local: readonly LocalHint[],
    index: number,
  ): LocalHint | null => local[index] ?? null;

  const teardown = (): void => {
    const current = session;
    session = null;
    if (current === null) return;
    current.controller.abort();
    current.buffer?.exit("explicit");
    current.mode?.exit("explicit");
  };

  const start = async (current: Session): Promise<void> => {
    const local = await detect(current.kind, current.controller.signal);
    if (session !== current) return;

    let remote: readonly RemoteHintDescriptor[] = [];
    if (app.frames.knownFrames().length > 1) {
      // Time-boxed and error-swallowing on purpose: a frame that never answers
      // must degrade to "hints for the frames that did", not to a dead page.
      remote = await withDeadline(
        app.frames.collectHints(current.kind).catch(() => []),
        COLLECT_DEADLINE_MS,
        [],
      );
      if (session !== current) return;
    }

    const entries = merge(local, remote);
    if (entries.length === 0) {
      app.hud.show("No links to select");
      teardown();
      return;
    }

    const buffered = current.buffer?.keys() ?? [];
    current.buffer = null;

    const mode = new HintMode({
      app,
      kind: current.kind,
      entries,
      crossFrame: remote.length > 0,
    });
    current.mode = mode;
    // Entering the mode evicts the buffer via the shared `hints` singleton.
    mode.enter();
    mode.start();
    mode.onExit(() => {
      if (session === current) session = null;
    });

    // Replay only in filter mode: in alphabet mode the buffered characters were
    // typed against hint strings that did not exist yet, so replaying them
    // would activate an essentially random link.
    if (app.settings().filterLinkHints && buffered.length > 0) {
      mode.replay(buffered);
    }
  };

  const activate = (kind: HintModeKind): void => {
    ensureStyles();
    teardown();

    const current: Session = {
      kind,
      controller: new AbortController(),
      buffer: null,
      mode: null,
    };
    session = current;

    // Buffer from the very first tick: detection is chunked and therefore
    // asynchronous even in a single frame, and fast typists get ahead of it.
    const buffer = new KeyBufferMode(app);
    current.buffer = buffer;
    buffer.enter();
    buffer.onExit((reason) => {
      if (reason === "escape" && session === current) teardown();
    });

    start(current).catch((cause: unknown) => {
      if (session === current) teardown();
      if (cause instanceof AbortedError) return;
      app.hud.error(
        `Hints failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    });
  };

  return {
    activate,

    isActive: (): boolean => session !== null,

    deactivate: (): void => {
      const wasActive = session !== null;
      teardown();
      if (wasActive) releaseHover();
    },

    collectLocal: async (
      kind: HintModeKind,
    ): Promise<readonly RemoteHintDescriptor[]> => {
      const controller = new AbortController();
      const hints = await detect(kind, controller.signal);
      roundOpenUntil = Date.now() + ROUND_TTL_MS;
      return descriptorsFor(app.frames.frameId, hints);
    },

    activateLocal: (localIndex: number, kind: HintModeKind): void => {
      if (Date.now() > roundOpenUntil) {
        lastLocal = [];
        return;
      }
      const hint = lastLocal[localIndex];
      if (hint === undefined) return;
      // One activation per round, so a single authorised request cannot be
      // replayed into a click on every element this frame ever hinted.
      roundOpenUntil = 0;
      activateLocalHint(app, hint, kind, "remote");
    },

    beginRemoteSession: (remote: RemoteHintSession): void => {
      ensureStyles();
      teardown();

      // `lastLocal` is this frame's answer to the `COLLECT_HINTS` that opened
      // the round, and the descriptors arrive with our own entries stripped, so
      // `merge` reassembles exactly the ordering the origin frame derived.
      const entries = merge(lastLocal, remote.descriptors);
      if (entries.length === 0) return;

      const current: Session = {
        kind: remote.mode,
        controller: new AbortController(),
        buffer: null,
        mode: null,
      };
      session = current;

      const mode = new HintMode({
        app,
        kind: remote.mode,
        entries,
        // Keys reach us over the relay; echoing them back would loop.
        crossFrame: false,
        role: "participant",
      });
      current.mode = mode;
      mode.enter();
      mode.start();
      mode.onExit(() => {
        if (session === current) session = null;
      });
    },

    handleRemoteKey: (notation: string): void => {
      session?.mode?.handleKey(notation);
    },
  };
};
