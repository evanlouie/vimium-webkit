/**
 * The top-frame coordinator (IMPLEMENTATION_PLAN.md §6.5).
 *
 * Reimplements the broker half of Vimium's `HintCoordinator` from
 * `background_scripts/main.js` — `prepareToActivateMode`, `getHintDescriptors`,
 * `activateMode`, `sendMessage` — in the top frame, because a userscript is
 * content-script-only and there is no background page to elect.
 *
 * The top frame elects *itself*. Nothing votes, nothing negotiates: children
 * post a `HELLO` at `window.top` and whoever is running there answers.
 *
 * Two rules that are easy to break and expensive to debug:
 *
 * - **Never trust a claimed origin.** Every inbound message arrives on a
 *   channel that already identifies its frame, so the connection's `frameId`
 *   wins over anything in the payload.
 * - **Never block on a frame.** Every request is time-boxed at
 *   `REQUEST_DEADLINE_MS` and failures resolve to empty. Sandboxed iframes,
 *   `about:blank` frames below Safari 18.4, and cross-origin frames throttled
 *   to 30fps until the user interacts with them are all *normal*, not
 *   exceptional — a mode that waits for them is a mode that hangs.
 */

import type {
  FrameId,
  HintMode,
  RemoteHintDescriptor,
} from "~/core/context.ts";
import { withDeadline } from "~/platform/scheduler.ts";
import {
  createNonce,
  createRequestIdFactory,
  DEFAULT_EXCLUSION,
  type EffectiveExclusion,
  ENVELOPE,
  FRAME_TO_TOP_KINDS,
  type FrameMessage,
  type FrameMessageKind,
  parseInbound,
  REQUEST_DEADLINE_MS,
  sortDescriptors,
} from "./protocol.ts";
import {
  type FrameChannel,
  FrameRegistry,
  messagePortChannel,
} from "./registry.ts";

const HELLO_ONLY: ReadonlySet<FrameMessageKind> = new Set<FrameMessageKind>([
  "HELLO",
]);

export interface CoordinatorOptions {
  /** The window whose frames tree admits `HELLO`s. `null` disables admission (tests). */
  readonly root: Window | null;
  /** Resolved from the *top frame's* URL; see `effectiveExclusion` below. */
  readonly resolveExclusion?: () => EffectiveExclusion;
  /** Current settings, snapshotted into `WELCOME` and `SETTINGS`. */
  readonly currentSettings?: () => unknown;
}

interface PendingCollect {
  readonly frameId: FrameId;
  readonly resolve: (descriptors: readonly RemoteHintDescriptor[]) => void;
}

export class FrameCoordinator {
  readonly #registry: FrameRegistry;
  readonly #options: CoordinatorOptions;
  readonly #nonce = createNonce();
  readonly #nextRequestId = createRequestIdFactory("top");
  readonly #pendingCollect = new Map<string, PendingCollect>();

  #focused: FrameId | null = null;
  #rosterScheduled = false;
  #disposed = false;
  #detach: (() => void) | null = null;

  constructor(options: CoordinatorOptions) {
    this.#options = options;
    this.#registry = new FrameRegistry({
      root: options.root,
      onChange: () => this.#scheduleRoster(),
    });
  }

  /** The session nonce. Exposed for the loopback endpoint, which skips `WELCOME` timing. */
  get nonce(): string {
    return this.#nonce;
  }

  knownFrames(): readonly FrameId[] {
    return this.#registry.ids();
  }

  /**
   * Start accepting `HELLO`s.
   *
   * Registration is accepted at any time and forever: WebKit's `document-start`
   * is unreliable, iframes are inserted after load, and a bfcache restore
   * re-runs the handshake. There is no "boot window" to close.
   */
  attach(target: Window): void {
    const onMessage = (event: MessageEvent): void =>
      this.#onWindowMessage(event);
    target.addEventListener("message", onMessage);
    this.#detach = () => target.removeEventListener("message", onMessage);
  }

  /** Register the coordinator's own frame over an in-process channel. */
  admitLocal(channel: FrameChannel): FrameId {
    return this.#admit(channel, null);
  }

  /** Re-publish settings and exclusion to every frame, e.g. after `AppContext.refresh()`. */
  pushSettings(): void {
    const exclusion = this.#exclusion();
    const settings = this.#options.currentSettings?.();
    this.#registry.broadcast(() => ({
      ...ENVELOPE,
      kind: "SETTINGS",
      nonce: this.#nonce,
      settings,
      exclusion,
    }));
  }

  dispose(): void {
    this.#disposed = true;
    this.#detach?.();
    this.#detach = null;
    for (const pending of this.#pendingCollect.values()) pending.resolve([]);
    this.#pendingCollect.clear();
    this.#registry.dispose();
  }

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  #onWindowMessage(event: MessageEvent): void {
    if (this.#disposed) return;

    // Ordering matters: parse before touching `event.source`, so a page
    // spamming `postMessage` costs us one property read and a string compare.
    const message = parseInbound(event.data, {
      expectedNonce: null,
      allowedKinds: HELLO_ONLY,
    });
    if (message === null) return;

    // Window-identity check. `event.source === window.frames[i]` works
    // cross-origin, and it is the only thing standing between us and a page
    // that hands out ports on behalf of frames it does not own.
    if (!this.#registry.isKnownWindow(event.source)) return;

    const port = event.ports[0];
    if (port === undefined) return;

    const channel = messagePortChannel(port);
    const frameId = this.#admit(channel, event.source);

    port.addEventListener("message", (portEvent: MessageEvent) => {
      this.#receive(frameId, portEvent.data);
    });
    // `messageerror` is the only failure event a port emits; an
    // unclonable payload means the peer is not who we think it is.
    port.addEventListener("messageerror", () => this.#registry.remove(frameId));
    port.start();
  }

  #admit(channel: FrameChannel, source: Window | null): FrameId {
    const record = this.#registry.register(channel, source);
    this.#registry.post(record.frameId, {
      ...ENVELOPE,
      kind: "WELCOME",
      nonce: this.#nonce,
      frameId: record.frameId,
      frames: this.#registry.ids(),
      settings: this.#options.currentSettings?.(),
      exclusion: this.#exclusion(),
    });
    if (this.#focused === null) this.#focused = record.frameId;
    return record.frameId;
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /** Exposed for the loopback endpoint; port traffic routes here too. */
  receive(frameId: FrameId, data: unknown): void {
    this.#receive(frameId, data);
  }

  #receive(frameId: FrameId, data: unknown): void {
    if (this.#disposed) return;
    const message = parseInbound(data, {
      expectedNonce: this.#nonce,
      allowedKinds: FRAME_TO_TOP_KINDS,
    });
    if (message === null) return;
    // A frame that was reaped mid-flight must not be able to talk its way back
    // in without a fresh `HELLO`.
    if (!this.#registry.has(frameId)) return;

    switch (message.kind) {
      case "REQUEST_HINTS":
        void this.#runHintRound(frameId, message.requestId, message.mode);
        return;

      case "HINTS":
        this.#resolveCollect(frameId, message.requestId, message.descriptors);
        return;

      case "ACTIVATE_HINT":
        this.#registry.post(message.targetFrameId, {
          ...ENVELOPE,
          kind: "ACTIVATE_HINT",
          nonce: this.#nonce,
          targetFrameId: message.targetFrameId,
          localIndex: message.localIndex,
          mode: message.mode,
        });
        return;

      case "KEYSTROKE":
        this.relayKey(frameId, message.notation);
        return;

      case "FOCUS_FRAME":
        this.focusFrame(message.direction);
        return;

      case "FOCUSED":
        this.#focused = frameId;
        return;

      case "EXCLUSION_REQUEST":
        this.#registry.post(frameId, {
          ...ENVELOPE,
          kind: "EXCLUSION_RESULT",
          nonce: this.#nonce,
          requestId: message.requestId,
          exclusion: this.#exclusion(),
        });
        return;

      case "GOODBYE":
        this.#registry.remove(frameId);
        return;

      default:
        // `HELLO` never arrives over a port, and `FRAME_TO_TOP_KINDS` has
        // already rejected every top-to-frame kind.
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Hints
  // -------------------------------------------------------------------------

  /**
   * One cross-frame hint round.
   *
   * Fan out `COLLECT_HINTS` to every frame *including* the origin, merge into
   * the canonical order, then answer the origin and tell everyone else a
   * session is live. The origin is queried too even though it already ran local
   * detection: without its descriptors the other frames would derive a
   * different hint-string assignment, and the whole scheme rests on every frame
   * agreeing.
   */
  async #runHintRound(
    originFrameId: FrameId,
    requestId: string,
    mode: HintMode,
  ): Promise<void> {
    const descriptors = await this.collectHints(mode);
    if (this.#disposed) return;

    // Strip the origin's own descriptors from its reply: it re-derives them
    // from the local hints it already holds. Upstream measured this as a 150%
    // speedup on link-dense pages, and it is the reason the heavy `LocalHint`
    // never crosses a frame boundary.
    this.#registry.post(originFrameId, {
      ...ENVELOPE,
      kind: "HINTS_RESULT",
      nonce: this.#nonce,
      requestId,
      descriptors: descriptors.filter((d) => d.frameId !== originFrameId),
    });

    this.#registry.broadcast((frameId) =>
      frameId === originFrameId ? null : {
        ...ENVELOPE,
        kind: "ACTIVATE",
        nonce: this.#nonce,
        originFrameId,
        mode,
        descriptors: descriptors.filter((d) => d.frameId !== frameId),
      }
    );
  }

  /** Ask every live frame for its descriptors and return them in canonical order. */
  async collectHints(
    mode: HintMode,
  ): Promise<readonly RemoteHintDescriptor[]> {
    const frameIds = this.#registry.ids();
    const replies = await Promise.all(
      frameIds.map((frameId) => this.#askFrame(frameId, mode)),
    );
    return sortDescriptors(replies.flat());
  }

  #askFrame(
    frameId: FrameId,
    mode: HintMode,
  ): Promise<readonly RemoteHintDescriptor[]> {
    const requestId = this.#nextRequestId();
    const answered = new Promise<readonly RemoteHintDescriptor[]>((resolve) => {
      this.#pendingCollect.set(requestId, { frameId, resolve });
    });

    if (
      !this.#registry.post(frameId, {
        ...ENVELOPE,
        kind: "COLLECT_HINTS",
        nonce: this.#nonce,
        requestId,
        mode,
      })
    ) {
      this.#pendingCollect.delete(requestId);
      return Promise.resolve([]);
    }

    // Time-boxed and swallowing: a frame that never answers contributes no
    // hints, and the mode still comes up for the frames that did.
    return withDeadline(answered, REQUEST_DEADLINE_MS, []).then((result) => {
      this.#pendingCollect.delete(requestId);
      return result;
    });
  }

  #resolveCollect(
    frameId: FrameId,
    requestId: string,
    descriptors: readonly RemoteHintDescriptor[],
  ): void {
    const pending = this.#pendingCollect.get(requestId);
    if (pending === undefined || pending.frameId !== frameId) return;
    this.#pendingCollect.delete(requestId);
    // A frame may only speak for itself. This is not a serious attack surface —
    // see the security note in protocol.ts — but attributing descriptors to a
    // frame that did not produce them would corrupt the shared ordering, which
    // is a correctness problem regardless of intent.
    pending.resolve(descriptors.filter((d) => d.frameId === frameId));
  }

  /** Relay a keystroke to every frame but the one it happened in. */
  relayKey(originFrameId: FrameId, notation: string): void {
    this.#registry.broadcast((frameId) =>
      frameId === originFrameId ? null : {
        ...ENVELOPE,
        kind: "KEYSTROKE",
        nonce: this.#nonce,
        originFrameId,
        notation,
      }
    );
  }

  /** Tell one frame to act on one of its own hints. */
  activateHint(
    targetFrameId: FrameId,
    localIndex: number,
    mode: HintMode,
  ): void {
    this.#registry.post(targetFrameId, {
      ...ENVELOPE,
      kind: "ACTIVATE_HINT",
      nonce: this.#nonce,
      targetFrameId,
      localIndex,
      mode,
    });
  }

  // -------------------------------------------------------------------------
  // Focus election (`gf` / `gF`)
  // -------------------------------------------------------------------------

  /**
   * Advance the focus cursor along document order and hand focus over.
   *
   * The cursor is corrected by `FOCUSED` notifications, so clicking into a
   * frame and then pressing `gf` continues from where the user actually is
   * rather than from wherever the cursor drifted to.
   */
  focusFrame(direction: 1 | -1): void {
    const frameIds = this.#registry.ids();
    if (frameIds.length < 2) return;

    const current = this.#focused === null
      ? -1
      : frameIds.indexOf(this.#focused);
    const base = current < 0 ? 0 : current;
    const next = frameIds[
      (base + direction + frameIds.length) % frameIds.length
    ];
    if (next === undefined) return;

    this.#focused = next;
    this.#registry.post(next, {
      ...ENVELOPE,
      kind: "TAKE_FOCUS",
      nonce: this.#nonce,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The effective exclusion, always from the top frame's URL.
   *
   * Upstream evaluates exclusion rules against `sender.tab.url` — the top
   * frame's URL — not the subframe's, so a rule matching the page applies to
   * every frame in it. Matching that behaviour is why children ask us at all.
   */
  #exclusion(): EffectiveExclusion {
    try {
      return this.#options.resolveExclusion?.() ?? DEFAULT_EXCLUSION;
    } catch {
      return DEFAULT_EXCLUSION;
    }
  }

  #scheduleRoster(): void {
    if (this.#rosterScheduled || this.#disposed) return;
    this.#rosterScheduled = true;
    queueMicrotask(() => {
      this.#rosterScheduled = false;
      if (this.#disposed) return;
      const frames = this.#registry.ids();
      this.#registry.broadcast((): FrameMessage => ({
        ...ENVELOPE,
        kind: "ROSTER",
        nonce: this.#nonce,
        frames,
      }));
    });
  }
}
