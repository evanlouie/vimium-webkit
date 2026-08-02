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
import { verifyFrameJoin } from "~/frames/auth.ts";
import { withDeadline } from "~/platform/scheduler.ts";
import {
  createNonce,
  createRequestIdFactory,
  DEFAULT_EXCLUSION,
  type EffectiveExclusion,
  ENVELOPE,
  FRAME_TO_TOP_KINDS,
  type FrameMessage,
  parseInbound,
  REQUEST_DEADLINE_MS,
  sortDescriptors,
  WINDOW_TO_TOP_KINDS,
} from "./protocol.ts";
import {
  type FrameChannel,
  FrameRegistry,
  messagePortChannel,
} from "./registry.ts";

/**
 * How long an issued admission token stays valid.
 *
 * Long enough to survive a busy main thread and a cross-origin frame throttled
 * to 30 fps; short enough that a token captured out of a page-world message
 * event is worthless by the time anyone looks at it.
 */
const CHALLENGE_TTL_MS = 10_000;

/** Outstanding challenges, capped so a `HELLO` flood cannot grow the map. */
const MAX_PENDING_CHALLENGES = 64;

/**
 * How long a hint round stays open for an `ACTIVATE_HINT`.
 *
 * Filter mode with `waitForEnterForFilteredHints` can legitimately keep a
 * session open while the user reads the page, so this is generous. It is a
 * bound on a capability, not a UX timeout.
 */
const ROUND_TTL_MS = 120_000;

export interface CoordinatorOptions {
  /** The window whose frames tree admits joins. `null` disables admission (tests). */
  readonly root: Window | null;
  /** Resolved from the *top frame's* URL; see `effectiveExclusion` below. */
  readonly resolveExclusion?: () => EffectiveExclusion;
  /** Credential read from manager-private storage. Required for admission. */
  readonly frameSecret?: () => Promise<string>;
}

interface PendingCollect {
  readonly frameId: FrameId;
  readonly resolve: (descriptors: readonly RemoteHintDescriptor[]) => void;
}

/** A token issued to one window, redeemable once. */
interface Challenge {
  readonly source: Window;
  readonly issuedAt: number;
}

/** The hint round currently authorised to drive other frames. */
interface ActiveRound {
  readonly originFrameId: FrameId;
  readonly requestId: string;
  readonly mode: HintMode;
  readonly startedAt: number;
}

export class FrameCoordinator {
  readonly #registry: FrameRegistry;
  readonly #options: CoordinatorOptions;
  readonly #nonce = createNonce();
  readonly #nextRequestId = createRequestIdFactory("top");
  readonly #pendingCollect = new Map<string, PendingCollect>();
  readonly #challenges = new Map<string, Challenge>();

  #focused: FrameId | null = null;
  #round: ActiveRound | null = null;
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
   * Start accepting handshakes.
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
    return this.#admit(channel, null, null);
  }

  /** Re-publish the exclusion decision to every frame, e.g. after a settings change. */
  pushSettings(): void {
    const exclusion = this.#exclusion();
    this.#registry.broadcast(() => ({
      ...ENVELOPE,
      kind: "SETTINGS",
      nonce: this.#nonce,
      exclusion,
    }));
  }

  dispose(): void {
    this.#disposed = true;
    this.#detach?.();
    this.#detach = null;
    this.#challenges.clear();
    this.#round = null;
    for (const pending of this.#pendingCollect.values()) pending.resolve([]);
    this.#pendingCollect.clear();
    this.#registry.dispose();
  }

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  /**
   * The `window`-level half of the handshake.
   *
   * `HELLO` earns a challenge; `JOIN` redeems one. Splitting it in two is what
   * lets the port be transferred to a known `targetOrigin` and what binds the
   * port to the window that announced itself — neither of which a single
   * `HELLO`-with-port could do.
   */
  #onWindowMessage(event: MessageEvent): void {
    if (this.#disposed) return;

    // Ordering matters: `parseInbound` rejects on four raw property reads
    // before it validates anything, so a page spamming `postMessage` costs us
    // almost nothing.
    const message = parseInbound(event.data, {
      expectedNonce: null,
      allowedKinds: WINDOW_TO_TOP_KINDS,
    });
    if (message === null) return;

    // Window identity does not prove the sender is our code — a page-controlled
    // `srcdoc` frame is genuinely in the tree — but it does prove the sender is
    // a frame on this page, and it rules out the coordinator's own window,
    // which is what made a page able to admit itself.
    if (!this.#registry.isKnownWindow(event.source)) return;
    const source = event.source;

    if (message.kind === "HELLO") {
      this.#challenge(source, event.origin);
      return;
    }
    if (message.kind !== "JOIN") return;

    const challenge = this.#challenges.get(message.token);
    // One-shot, whether or not it turns out to be redeemable.
    this.#challenges.delete(message.token);
    if (challenge === undefined || challenge.source !== source) return;
    if (Date.now() - challenge.issuedAt > CHALLENGE_TTL_MS) return;

    const port = event.ports[0];
    if (port === undefined) return;

    this.#completeJoin(
      port,
      source,
      message.token,
      message.helloId,
      message.proof,
    ).catch(() => {
      port.close();
    });
  }

  async #completeJoin(
    port: MessagePort,
    source: Window,
    token: string,
    helloId: string,
    proof: string,
  ): Promise<void> {
    const secret = await this.#options.frameSecret?.() ?? "";
    if (!(await verifyFrameJoin(secret, token, helloId, proof))) {
      port.close();
      return;
    }
    if (this.#disposed || !this.#registry.isKnownWindow(source)) {
      port.close();
      return;
    }

    const channel = messagePortChannel(port);
    const frameId = this.#admit(channel, source, helloId);

    port.addEventListener("message", (portEvent: MessageEvent) => {
      this.#receive(frameId, portEvent.data);
    });
    // `messageerror` is the only failure event a port emits; an
    // unclonable payload means the peer is not who we think it is.
    port.addEventListener("messageerror", () => {
      this.#registry.remove(frameId);
    });
    port.start();
  }

  /**
   * Issue a one-shot token to exactly one window.
   *
   * `targetOrigin` is the announcing frame's own origin, taken from the event
   * rather than guessed, so the token is not readable by any other document —
   * and in particular not by the top page, which is what an unrestricted
   * `"*"` would have allowed on a same-origin child.
   */
  #challenge(source: Window, origin: string): void {
    this.#expireChallenges();
    if (this.#challenges.size >= MAX_PENDING_CHALLENGES) return;

    const token = createNonce();
    this.#challenges.set(token, { source, issuedAt: Date.now() });
    try {
      source.postMessage(
        { ...ENVELOPE, kind: "CHALLENGE", token },
        // `"null"` is what an opaque origin (`srcdoc`, sandboxed, `data:`)
        // reports, and it is not a valid `targetOrigin`. Those frames are
        // reachable only through `"*"`, and they are also the ones whose
        // origin we would not be authenticating anyway.
        origin === "null" || origin === "" ? "*" : origin,
      );
    } catch {
      // A frame detached between the `HELLO` and now. The token expires.
    }
  }

  #expireChallenges(): void {
    const now = Date.now();
    for (const [token, challenge] of this.#challenges) {
      if (now - challenge.issuedAt > CHALLENGE_TTL_MS) {
        this.#challenges.delete(token);
      }
    }
  }

  #admit(
    channel: FrameChannel,
    source: Window | null,
    helloId: string | null,
  ): FrameId {
    const record = this.#registry.register(channel, source);
    this.#registry.post(record.frameId, {
      ...ENVELOPE,
      kind: "WELCOME",
      nonce: this.#nonce,
      frameId: record.frameId,
      // The loopback endpoint has no attempt to echo; it is not racing anyone.
      helloId: helloId ?? "",
      frames: this.#registry.ids(),
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
    // Before the parse, not after: a frame that was reaped mid-flight must not
    // be able to talk its way back in without a fresh handshake, and it must
    // not be able to make us validate a descriptor array on the way to being
    // rejected.
    if (!this.#registry.has(frameId)) return;

    const message = parseInbound(data, {
      expectedNonce: this.#nonce,
      allowedKinds: FRAME_TO_TOP_KINDS,
    });
    if (message === null) return;

    switch (message.kind) {
      case "REQUEST_HINTS":
        // One live round globally. Without this an admitted frame could start
        // unlimited detection passes and descriptor aggregations in parallel.
        if (this.#round !== null && this.#ownsLiveRound()) return;
        this.#round = {
          originFrameId: frameId,
          requestId: message.requestId,
          mode: message.mode,
          startedAt: Date.now(),
        };
        this.#runHintRound(frameId, message.requestId, message.mode).catch(
          () => {},
        );
        return;

      case "HINTS":
        this.#resolveCollect(frameId, message.requestId, message.descriptors);
        return;

      case "ACTIVATE_HINT":
        // The single most consequential relay in the protocol: it ends in a
        // programmatic click, hover, focus or clipboard write inside a document
        // of a different origin. `#resolveCollect` already enforces "a frame may
        // only speak for itself" for descriptors; this is the same discipline
        // for the action. Only the frame that started the live round may drive
        // it, and only once.
        if (!this.#ownsRound(frameId, message.mode)) return;
        this.#round = null;
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
        // Keystrokes only mean anything inside a round, and only the frame the
        // user is typing into has any business broadcasting them.
        if (this.#round?.originFrameId !== frameId) return;
        this.relayKey(frameId, message.notation);
        if (message.notation === "<esc>") this.#round = null;
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
        if (this.#round?.originFrameId === frameId) this.#round = null;
        this.#registry.remove(frameId);
        return;

      default:
        // `HELLO`/`JOIN` never arrive over a port, and `FRAME_TO_TOP_KINDS` has
        // already rejected every top-to-frame kind.
        return;
    }
  }

  #ownsLiveRound(): boolean {
    const round = this.#round;
    if (round === null) return false;
    if (Date.now() - round.startedAt > ROUND_TTL_MS) {
      this.#round = null;
      return false;
    }
    return true;
  }

  /** Is `frameId` the frame that started the live round, in the same mode? */
  #ownsRound(frameId: FrameId, mode: HintMode): boolean {
    return this.#ownsLiveRound() &&
      this.#round?.originFrameId === frameId && this.#round.mode === mode;
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
    if (
      this.#round?.originFrameId !== originFrameId ||
      this.#round.requestId !== requestId
    ) return;

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

  /**
   * Tell one frame to act on one of its own hints.
   *
   * The top frame's own path, so there is no round to authorise against — the
   * caller *is* the coordinator. Frames reach this through `ACTIVATE_HINT`,
   * which is checked in `#receive`.
   */
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
