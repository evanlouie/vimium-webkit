/**
 * Cross-frame coordination (IMPLEMENTATION_PLAN.md §6.5).
 *
 * Adapted from Vimium's frame protocol: `content_scripts/vimium_frontend.js`
 * (frame registration, `focusFrame`) and `background_scripts/main.js`
 * (`HintCoordinator`). The broker lives in the top frame here because a
 * userscript is content-script-only.
 *
 * ## Shape
 *
 * Every frame — including the top one — runs a `FrameEndpoint`, the "frame
 * side" of the protocol. Children reach the coordinator over a transferred
 * `MessagePort`; the top frame reaches its own coordinator over an in-process
 * loopback. That symmetry is deliberate: there is exactly one code path for
 * collecting hints, relaying keys, and resolving exclusions, and no
 * `if (isTop)` scattered through the logic.
 *
 * ```
 *   child frame                 top frame
 *   ┌───────────┐  HELLO+port  ┌───────────┐
 *   │ Endpoint  │─────────────▶│Coordinator│◀─┐ loopback
 *   │           │◀────port─────│ +Registry │──┘   ▼
 *   └───────────┘   WELCOME    └───────────┘   Endpoint
 * ```
 *
 * ## Frames we will never reach
 *
 * CSP-`sandbox`ed iframes get no injection in Safari or Firefox
 * (w3c/webextensions#285); `about:blank`, `srcdoc` and `data:` frames get none
 * below Safari 18.4; cross-origin frames are throttled to 30fps until the user
 * interacts with them (WebKit r215070). All three are ordinary, not
 * exceptional. Nothing here waits on a frame: every request is time-boxed at
 * `REQUEST_DEADLINE_MS` and resolves to an empty/default answer. Overlay
 * animation must use CSS transitions rather than rAF for the same reason.
 */

import type {
  FrameId,
  FrameLinkApi,
  HintMode,
  RemoteHintDescriptor,
} from "~/core/context.ts";
import { withDeadline } from "~/platform/scheduler.ts";
import { FrameCoordinator } from "./coordinator.ts";
import {
  createRequestIdFactory,
  DEFAULT_EXCLUSION,
  type EffectiveExclusion,
  ENVELOPE,
  type FrameMessage,
  parseInbound,
  REQUEST_DEADLINE_MS,
  TOP_TO_FRAME_KINDS,
} from "./protocol.ts";
import { loopbackChannel } from "./registry.ts";

export { FrameCoordinator } from "./coordinator.ts";
export {
  compareDescriptors,
  DEFAULT_EXCLUSION,
  type EffectiveExclusion,
  type FrameMessage,
  type FrameMessageKind,
  PROTOCOL_MAGIC,
  PROTOCOL_VERSION,
  REQUEST_DEADLINE_MS,
  sortDescriptors,
} from "./protocol.ts";
export { collectFrameWindows, FrameRegistry } from "./registry.ts";

/**
 * The id a frame uses before it has been welcomed.
 *
 * Sorts after every real (`f`-prefixed) id, so a hint session started in the
 * handshake gap still has a total order. Such a session is local-only anyway:
 * `knownFrames()` reports a single frame until `WELCOME` lands.
 */
const PROVISIONAL_FRAME_ID = "local";

/**
 * Handshake retries.
 *
 * `document-start` is unreliable on WebKit, so a child can send its `HELLO`
 * before the top frame has installed its listener — the message is then simply
 * gone. Retrying a few times costs three `postMessage`s in the worst case and
 * is the difference between "hints work" and "this iframe is invisible to
 * Vimium for the life of the page". Each attempt needs a fresh `MessageChannel`
 * because `port2` cannot be transferred twice.
 */
const HANDSHAKE_RETRY_MS = [150, 600, 1800] as const;

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

/** A cross-frame hint session, as seen by a frame that did not start it. */
export interface RemoteHintSession {
  readonly originFrameId: FrameId;
  readonly mode: HintMode;
  /**
   * The globally ordered descriptor set, with the recipient's own entries
   * stripped — it re-derives those from the local hints it still holds.
   */
  readonly descriptors: readonly RemoteHintDescriptor[];
}

/**
 * What the coordinator needs from *this* frame's hints subsystem.
 *
 * Structurally satisfied by `LocalHintsApi` (`features/hints/index.ts`).
 */
export interface LocalHintsBridge {
  collectLocal(mode: HintMode): Promise<readonly RemoteHintDescriptor[]>;
  activateLocal(localIndex: number, mode: HintMode): void;
  handleRemoteKey(notation: string): void;
  /**
   * Start a marker session for a round another frame initiated.
   *
   * Optional only because `createFrameLink` is used without a hints subsystem
   * in tests and in frames that never build one; `stage1.ts` always provides
   * it.
   */
  beginRemoteSession?(session: RemoteHintSession): void;
}

export interface FrameLinkOptions {
  readonly isTop: boolean;
  /** Called on the top frame to resolve exclusions from its own URL. */
  readonly resolveExclusion?: () => EffectiveExclusion;
  /** Bound by stage1 so the coordinator can ask *this* frame for its hints. */
  readonly localHints?: LocalHintsBridge;
  /** Snapshotted into `WELCOME` and `SETTINGS`. Top frame only. */
  readonly currentSettings?: () => unknown;
  /**
   * Settings *and* the effective exclusion handed down by the top frame.
   *
   * Both arrive together in `WELCOME` and `SETTINGS`, and both matter: a
   * subframe that boots before it is welcomed has been running fully enabled
   * on a page the user excluded, and the exclusion is the only thing that can
   * tell it so (FRM-04). Re-validate the settings before use.
   */
  readonly onSettingsPushed?: (
    settings: unknown,
    exclusion: EffectiveExclusion,
  ) => void;
  /** Flash a frame indicator; `gf` has just handed this frame focus. */
  readonly onTakeFocus?: () => void;
  /** Injection seam. Defaults to the ambient `window`. */
  readonly window?: Window;
}

/** `FrameLinkApi` plus the top-frame-only republish hook. */
export interface FrameLink extends FrameLinkApi {
  /** Re-publish settings and exclusion to every frame. No-op below the top. */
  pushSettings(): void;
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

interface EndpointOptions {
  readonly localHints?: LocalHintsBridge;
  readonly onSettingsPushed?: (
    settings: unknown,
    exclusion: EffectiveExclusion,
  ) => void;
  readonly onTakeFocus?: () => void;
  readonly window?: Window;
}

/**
 * The frame side of the protocol: identical in the top frame and in children,
 * differing only in the transport bound by `bindTransport`.
 */
class FrameEndpoint {
  readonly #options: EndpointOptions;
  readonly #nextRequestId = createRequestIdFactory("r");
  readonly #pendingHints = new Map<
    string,
    (descriptors: readonly RemoteHintDescriptor[]) => void
  >();
  readonly #pendingExclusion = new Map<
    string,
    (exclusion: EffectiveExclusion) => void
  >();
  readonly #ready: Promise<boolean>;

  #send: ((message: FrameMessage) => void) | null = null;
  #frameId: FrameId = PROVISIONAL_FRAME_ID;
  #nonce: string | null = null;
  #roster: readonly FrameId[] = [];
  #exclusion: EffectiveExclusion = DEFAULT_EXCLUSION;
  #welcomed = false;
  #resolveReady: (welcomed: boolean) => void = () => {};
  #onWelcome: (() => void) | null = null;
  #disposed = false;

  constructor(options: EndpointOptions) {
    this.#options = options;
    this.#ready = new Promise<boolean>((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  get frameId(): FrameId {
    return this.#frameId;
  }

  get nonce(): string | null {
    return this.#nonce;
  }

  bindTransport(send: (message: FrameMessage) => void): void {
    this.#send = send;
  }

  /** Called once, the first time `WELCOME` lands. Cancels handshake retries. */
  onWelcome(callback: () => void): void {
    this.#onWelcome = callback;
  }

  // --- inbound ------------------------------------------------------------

  receive(data: unknown): void {
    if (this.#disposed) return;
    const message = parseInbound(data, {
      expectedNonce: this.#nonce,
      allowedKinds: TOP_TO_FRAME_KINDS,
    });
    if (message === null) return;

    switch (message.kind) {
      case "WELCOME":
        this.#frameId = message.frameId;
        this.#nonce = message.nonce;
        this.#roster = message.frames;
        this.#exclusion = message.exclusion;
        this.#welcomed = true;
        this.#resolveReady(true);
        this.#onWelcome?.();
        this.#options.onSettingsPushed?.(message.settings, message.exclusion);
        return;

      case "ROSTER":
        this.#roster = message.frames;
        return;

      case "SETTINGS":
        this.#exclusion = message.exclusion;
        this.#options.onSettingsPushed?.(message.settings, message.exclusion);
        return;

      case "COLLECT_HINTS":
        void this.#answerCollect(message.requestId, message.mode);
        return;

      case "HINTS_RESULT": {
        const resolve = this.#pendingHints.get(message.requestId);
        this.#pendingHints.delete(message.requestId);
        resolve?.(message.descriptors);
        return;
      }

      case "ACTIVATE":
        this.#options.localHints?.beginRemoteSession?.({
          originFrameId: message.originFrameId,
          mode: message.mode,
          descriptors: message.descriptors,
        });
        return;

      case "ACTIVATE_HINT":
        this.#options.localHints?.activateLocal(
          message.localIndex,
          message.mode,
        );
        return;

      case "KEYSTROKE":
        this.#options.localHints?.handleRemoteKey(message.notation);
        return;

      case "TAKE_FOCUS":
        this.#takeFocus();
        return;

      case "EXCLUSION_RESULT": {
        this.#exclusion = message.exclusion;
        const resolve = this.#pendingExclusion.get(message.requestId);
        this.#pendingExclusion.delete(message.requestId);
        resolve?.(message.exclusion);
        return;
      }

      default:
        // `TOP_TO_FRAME_KINDS` has already rejected every frame-to-top kind.
        return;
    }
  }

  // --- outbound -----------------------------------------------------------

  ready(): Promise<boolean> {
    if (this.#welcomed) return Promise.resolve(true);
    // Resolving `false` rather than rejecting: "no coordinator" is a supported
    // configuration (sandboxed parent, cross-origin ancestor with no
    // injection), not an error the caller should have to catch.
    return withDeadline(this.#ready, REQUEST_DEADLINE_MS, false);
  }

  knownFrames(): readonly FrameId[] {
    return this.#roster.length > 0 ? this.#roster : [this.#frameId];
  }

  collectHints(mode: HintMode): Promise<readonly RemoteHintDescriptor[]> {
    if (this.#nonce === null) return Promise.resolve([]);
    const requestId = this.#nextRequestId();
    const answered = new Promise<readonly RemoteHintDescriptor[]>((resolve) => {
      this.#pendingHints.set(requestId, resolve);
    });

    if (
      !this.#post({
        ...ENVELOPE,
        kind: "REQUEST_HINTS",
        nonce: this.#nonce,
        requestId,
        mode,
      })
    ) {
      this.#pendingHints.delete(requestId);
      return Promise.resolve([]);
    }

    return withDeadline(answered, REQUEST_DEADLINE_MS, []).then((result) => {
      this.#pendingHints.delete(requestId);
      return result;
    });
  }

  activateHint(frameId: FrameId, localIndex: number, mode: HintMode): void {
    // Short-circuit our own hints instead of round-tripping through the top
    // frame. This is not just latency: `activate-new-tab` and the clipboard
    // modes consume transient activation, and Safari's activation window does
    // not survive two `postMessage` hops.
    if (frameId === this.#frameId) {
      this.#options.localHints?.activateLocal(localIndex, mode);
      return;
    }
    if (this.#nonce === null) return;
    this.#post({
      ...ENVELOPE,
      kind: "ACTIVATE_HINT",
      nonce: this.#nonce,
      targetFrameId: frameId,
      localIndex,
      mode,
    });
  }

  broadcastKey(notation: string): void {
    if (this.#nonce === null) return;
    this.#post({
      ...ENVELOPE,
      kind: "KEYSTROKE",
      nonce: this.#nonce,
      originFrameId: this.#frameId,
      notation,
    });
  }

  focusFrame(direction: 1 | -1): void {
    if (this.#nonce === null) return;
    this.#post({
      ...ENVELOPE,
      kind: "FOCUS_FRAME",
      nonce: this.#nonce,
      direction,
    });
  }

  notifyFocused(): void {
    if (this.#nonce === null) return;
    this.#post({ ...ENVELOPE, kind: "FOCUSED", nonce: this.#nonce });
  }

  /**
   * Ask the *top* frame for the effective exclusion.
   *
   * Upstream evaluates exclusion rules against `sender.tab.url`, which is the
   * top frame's URL rather than the subframe's. Resolving locally would mean a
   * rule written for a page stops applying inside its own iframes.
   */
  effectiveExclusion(): Promise<EffectiveExclusion> {
    if (this.#nonce === null) return Promise.resolve(this.#exclusion);
    const requestId = this.#nextRequestId();
    const answered = new Promise<EffectiveExclusion>((resolve) => {
      this.#pendingExclusion.set(requestId, resolve);
    });

    if (
      !this.#post({
        ...ENVELOPE,
        kind: "EXCLUSION_REQUEST",
        nonce: this.#nonce,
        requestId,
      })
    ) {
      this.#pendingExclusion.delete(requestId);
      return Promise.resolve(this.#exclusion);
    }

    // Falls back to the last value we were told, or `DEFAULT_EXCLUSION`
    // ("enabled, pass nothing") if we were never told anything. Defaulting to
    // *disabled* would silently kill Vimium in every frame whose ancestor did
    // not inject.
    return withDeadline(answered, REQUEST_DEADLINE_MS, this.#exclusion).then(
      (result) => {
        this.#pendingExclusion.delete(requestId);
        return result;
      },
    );
  }

  sendGoodbye(): void {
    if (this.#nonce === null) return;
    this.#post({ ...ENVELOPE, kind: "GOODBYE", nonce: this.#nonce });
  }

  dispose(): void {
    this.#disposed = true;
    this.#send = null;
    this.#onWelcome = null;
    for (const resolve of this.#pendingHints.values()) resolve([]);
    this.#pendingHints.clear();
    for (const resolve of this.#pendingExclusion.values()) {
      resolve(this.#exclusion);
    }
    this.#pendingExclusion.clear();
    this.#resolveReady(false);
  }

  // --- internals ----------------------------------------------------------

  async #answerCollect(requestId: string, mode: HintMode): Promise<void> {
    const bridge = this.#options.localHints;
    // Swallowed on purpose: a frame whose detection throws should contribute
    // nothing, not abort the round for every other frame.
    const descriptors = bridge === undefined ? [] : await withDeadline(
      bridge.collectLocal(mode).catch(() => []),
      REQUEST_DEADLINE_MS,
      [],
    );
    if (this.#disposed || this.#nonce === null) return;
    this.#post({
      ...ENVELOPE,
      kind: "HINTS",
      nonce: this.#nonce,
      requestId,
      descriptors,
    });
  }

  #takeFocus(): void {
    const view = this.#options.window;
    try {
      view?.focus();
    } catch {
      // `window.focus()` is a no-op or throws in frames the user has not
      // interacted with. The HUD flash below is what the user actually sees.
    }
    this.#options.onTakeFocus?.();
  }

  #post(message: FrameMessage): boolean {
    if (this.#send === null) return false;
    this.#send(message);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const ambientWindow = (): Window | null =>
  typeof window === "undefined" ? null : window;

/**
 * A link with no coordinator behind it.
 *
 * Used when there is no DOM at all (unit tests) and when `window.top` is
 * unreachable. Every operation degrades to "this frame only" rather than
 * failing, because from the user's point of view a frame with no coordinator is
 * simply a page with one frame.
 */
const standaloneLink = (
  options: FrameLinkOptions,
  endpoint: FrameEndpoint,
): FrameLink => ({
  get frameId(): FrameId {
    return endpoint.frameId;
  },
  isTop: options.isTop,
  ready: () => Promise.resolve(false),
  knownFrames: () => [endpoint.frameId],
  collectHints: () => Promise.resolve([]),
  activateHint: (frameId, localIndex, mode) =>
    endpoint.activateHint(frameId, localIndex, mode),
  broadcastKey: () => {},
  focusFrame: () => {},
  effectiveExclusion: () => Promise.resolve(DEFAULT_EXCLUSION),
  pushSettings: () => {},
  dispose: () => endpoint.dispose(),
});

/**
 * Build this frame's link to the coordinator.
 *
 * Works in three configurations, and the caller does not have to know which one
 * it got: top frame (self-registration, no `postMessage` round trip), child
 * frame with a reachable top, and child frame whose top is unreachable.
 */
export const createFrameLink = (options: FrameLinkOptions): FrameLink => {
  const view = options.window ?? ambientWindow();

  const endpoint = new FrameEndpoint({
    localHints: options.localHints,
    onSettingsPushed: options.onSettingsPushed,
    onTakeFocus: options.onTakeFocus,
    window: view ?? undefined,
  });

  if (view === null) return standaloneLink(options, endpoint);

  const teardown: Array<() => void> = [];
  let coordinator: FrameCoordinator | null = null;

  if (options.isTop) {
    coordinator = new FrameCoordinator({
      root: view,
      resolveExclusion: options.resolveExclusion,
      currentSettings: options.currentSettings,
    });
    coordinator.attach(view);

    // The coordinator's own frame joins on the same terms as everyone else,
    // just over an in-process channel. It receives a real `WELCOME`, so no
    // state below has to know whether it is the broker.
    const broker = coordinator;
    const frameId = broker.admitLocal(
      loopbackChannel((message) => endpoint.receive(message)),
    );
    endpoint.bindTransport((message) => broker.receive(frameId, message));
    teardown.push(() => broker.dispose());
  } else {
    teardown.push(connectToTop(view, endpoint));
  }

  // Keeps the coordinator's `gf` cursor pointing at the frame the user is
  // actually in, rather than at wherever the cursor last landed.
  const onFocus = (): void => endpoint.notifyFocused();
  view.addEventListener("focus", onFocus);
  teardown.push(() => view.removeEventListener("focus", onFocus));

  // Safari caches pages with `unload` handlers into bfcache and never runs
  // `unload`, so `pagehide`/`pageshow` is the only correct lifecycle signal
  // (§7.10). `connectToTop` re-runs the handshake on a persisted restore.
  const onPageHide = (): void => endpoint.sendGoodbye();
  view.addEventListener("pagehide", onPageHide);
  teardown.push(() => view.removeEventListener("pagehide", onPageHide));

  return {
    get frameId(): FrameId {
      return endpoint.frameId;
    },
    isTop: options.isTop,
    ready: () => endpoint.ready(),
    knownFrames: () =>
      coordinator === null ? endpoint.knownFrames() : coordinator.knownFrames(),
    collectHints: (mode) => endpoint.collectHints(mode),
    activateHint: (frameId, localIndex, mode) =>
      endpoint.activateHint(frameId, localIndex, mode),
    broadcastKey: (notation) => endpoint.broadcastKey(notation),
    focusFrame: (direction) => endpoint.focusFrame(direction),
    effectiveExclusion: () => endpoint.effectiveExclusion(),
    pushSettings: () => coordinator?.pushSettings(),
    dispose: () => {
      endpoint.sendGoodbye();
      endpoint.dispose();
      for (const undo of teardown.reverse()) undo();
    },
  };
};

/**
 * Child-side handshake: create a `MessageChannel`, transfer `port2` to the top
 * frame inside a `HELLO`, and speak the rest of the protocol over `port1`.
 *
 * `MessagePort` transfer over a cross-origin `postMessage` works, and it is
 * what makes per-keystroke relaying affordable: without it every keystroke
 * would have to be re-broadcast through `window.postMessage` and filtered by
 * every frame on the page.
 */
const connectToTop = (view: Window, endpoint: FrameEndpoint): () => void => {
  const timers: number[] = [];
  let port: MessagePort | null = null;
  let closed = false;

  const top = view.top;
  // `view.top === view` with `isTop: false` means the caller is confused, or we
  // are in a frame that was detached after boot. Either way there is nobody to
  // hand a port to.
  if (top === null || top === view) return () => {};

  const attempt = (): void => {
    if (closed) return;
    const channel = new MessageChannel();
    port?.close();
    port = channel.port1;

    channel.port1.addEventListener("message", (event: MessageEvent) => {
      endpoint.receive(event.data);
    });
    channel.port1.start();
    endpoint.bindTransport((message) => {
      // Posting to a port whose peer document is gone does not throw; it is
      // silently dropped. Liveness is the coordinator's problem (it sweeps the
      // frames tree) and every request here is deadline-bounded regardless.
      try {
        channel.port1.postMessage(message);
      } catch {
        // Structured-clone failure only. Our payloads are plain JSON.
      }
    });

    try {
      // `"*"` because we cannot know the top frame's origin — that is the whole
      // reason this channel exists. Safe: `HELLO` carries no secret. The nonce
      // travels the other way, over the port, and only to whoever we handed
      // `port2` to.
      top.postMessage({ ...ENVELOPE, kind: "HELLO" }, "*", [channel.port2]);
    } catch {
      // A detached or otherwise hostile `top` proxy. Retries below may still
      // succeed if the frame is re-attached.
    }
  };

  endpoint.onWelcome(() => {
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
  });

  attempt();
  for (const delay of HANDSHAKE_RETRY_MS) {
    timers.push(setTimeout(attempt, delay));
  }

  const onPageShow = (event: PageTransitionEvent): void => {
    // A bfcache restore brings back a document whose ports the coordinator has
    // already reaped. Re-registering is cheap and the registry re-keys us to
    // the same frame id, since our window identity has not changed.
    if (event.persisted) attempt();
  };
  view.addEventListener("pageshow", onPageShow);

  return () => {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    view.removeEventListener("pageshow", onPageShow);
    port?.close();
    port = null;
  };
};
