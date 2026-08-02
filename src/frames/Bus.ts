/**
 * The transport between the frames of one page.
 *
 * Every frame runs one bus. A child frame reaches the top frame over a
 * `MessagePort` that it transfers during the handshake. The top frame is the
 * coordinator: it holds one port for each child, and it relays a message from
 * one child to another. The top frame talks to itself through the same
 * `PubSub` that it delivers a remote message into, so no service has to ask
 * whether it is the coordinator.
 *
 * ```
 *   child frame                 top frame
 *   ┌───────────┐  HELLO+port  ┌───────────┐
 *   │  FrameBus │─────────────▶│  FrameBus │
 *   │           │◀────port─────│ +registry │
 *   └───────────┘   WELCOME    └───────────┘
 * ```
 *
 * This module knows about `postMessage`, about who a peer is, and about
 * authentication. It knows nothing about hints, exclusions or history. A
 * service that wants a message subscribes to `incoming`, or answers one kind of
 * request with `serve`. Two services that need each other therefore do not
 * import each other, and the layer graph stays a tree.
 *
 * ## Frames that we will never reach
 *
 * A frame with a CSP `sandbox` gets no injection in Safari or in Firefox. An
 * `about:blank`, a `srcdoc` and a `data:` frame get none below Safari 18.4. A
 * cross-origin frame is throttled to 30 frames each second until the user
 * interacts with it. All three are usual, and not exceptional. Nothing here
 * waits for a frame: every request has a deadline and gives a failure that the
 * caller can answer with a default.
 */

import {
  Context,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  encodeMessage,
  ENVELOPE,
  type FrameMessage,
  type FrameWire,
  type JoinMessage,
  joinProofPayload,
  type MessageKind,
  NO_REQUEST_ID,
  parseChallenge,
  parseWelcome,
  parseWindowToTop,
  parseWire,
  peekKind,
  REQUEST_DEADLINE_MS,
  type WelcomeMessage,
  WIRE_TARGET_ALL,
  WIRE_TARGET_TOP,
} from "~/domain/FrameMessage.ts";
import { Dom } from "~/platform/Dom.ts";
import {
  ANNOUNCE_MESSAGE,
  type FrameId,
  Realm,
  WAKE_MESSAGE,
} from "~/platform/Realm.ts";
import { FrameAuth } from "./Auth.ts";

// ---------------------------------------------------------------------------
// Bounds and delays
// ---------------------------------------------------------------------------

/**
 * The delays between two announcements of a child frame.
 *
 * `document-start` is not reliable on WebKit, so a child can send its `HELLO`
 * before the top frame has installed its listener. The message is then gone.
 * Three more posts in the worst case are the difference between "hints work"
 * and "this frame is invisible for the life of the page".
 */
const HANDSHAKE_RETRY_MS = [150, 600, 1800] as const;

/**
 * How long an admission token stays valid.
 *
 * Long enough for a busy main thread and for a cross-origin frame that is
 * throttled. Short enough that a token which a page read out of a message event
 * is worth nothing by the time anybody looks at it.
 */
const CHALLENGE_TTL_MS = 10_000;

/** The ceiling on open challenges, so a flood of `HELLO` cannot grow the map. */
const MAX_PENDING_CHALLENGES = 64;

/**
 * The ceilings for the walk of the frames tree.
 *
 * A page with many advertisements nests frames without limit, and this walk
 * runs whenever the roster is read. Bounded work is better than a walk that is
 * complete but has no limit.
 */
const MAX_TREE_DEPTH = 16;
const MAX_TREE_NODES = 512;

/** The deadline of a request, in the form that `Effect.timeout` takes. */
export const REQUEST_DEADLINE: Duration.Input = REQUEST_DEADLINE_MS;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const FrameFailureReason = Schema.Literals([
  /** The peer did not answer inside the deadline. */
  "timeout",
  /** This frame is not admitted to the session. */
  "unauthenticated",
  /** The message did not match the wire schema. */
  "malformed",
  /** There is no frame with that identity, or there is no link to the top. */
  "no-peer",
  /** The browser refused the post. */
  "failed",
]);

export type FrameFailureReason = typeof FrameFailureReason.Type;

export class FrameError extends Schema.TaggedErrorClass<FrameError>()(
  "FrameError",
  {
    reason: FrameFailureReason,
    detail: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Targets and inbound messages
// ---------------------------------------------------------------------------

export type FrameTarget =
  | { readonly _tag: "Top" }
  | { readonly _tag: "All" }
  | { readonly _tag: "Frame"; readonly frameId: FrameId };

/** The coordinator. In the top frame this is the frame itself. */
export const toTop: FrameTarget = { _tag: "Top" };

/** Every frame that this frame can reach, and not this frame. */
export const toAll: FrameTarget = { _tag: "All" };

export const toFrame = (frameId: FrameId): FrameTarget => ({
  _tag: "Frame",
  frameId,
});

/** One message that reached this frame and passed every check. */
export interface InboundMessage {
  /** The frame that sent it. The coordinator checked this against the port. */
  readonly from: FrameId;
  /** The correlation id, when the message is a request or a reply. */
  readonly requestId: Option.Option<string>;
  readonly message: FrameMessage;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The wire carries a plain string.
 *
 * `FrameId` is a brand, which exists at compile time only, so this changes no
 * value. The identity itself is checked by the coordinator, which compares the
 * `from` field against the port that the message came on.
 */
const asFrameId = (value: string): FrameId => value as FrameId;

const describe = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
};

/**
 * The origin to post to.
 *
 * An opaque origin, which a `srcdoc`, a sandboxed and a `data:` frame reports,
 * is the text `"null"`, and that is not a valid `targetOrigin`. Those frames
 * are reachable through `"*"` only, and they are also the frames whose origin
 * we could not authenticate in any case.
 */
const targetOrigin = (origin: string): string =>
  origin === "null" || origin === "" ? "*" : origin;

/**
 * Every window that `root` can reach, in document order.
 *
 * `window.frames.length` and `window.frames[index]` are readable across
 * origins, which few things are, so this walk works when every child has a
 * different origin. A frame that we can never talk to is in this list as well.
 * It simply never sends a `HELLO`, which is the "absent, and not blocking"
 * behaviour that we want.
 *
 * The root itself is not in the list. The coordinator once treated its own
 * window as known, and a page could then post itself a `HELLO` and be admitted
 * as a frame, with the session nonce delivered straight back to it.
 */
const collectFrameWindows = (root: Window): readonly Window[] => {
  const out: Window[] = [];

  const walk = (parent: Window, depth: number): void => {
    if (depth >= MAX_TREE_DEPTH || out.length >= MAX_TREE_NODES) return;
    let count = 0;
    try {
      count = parent.frames.length;
    } catch {
      // A frame can become unreachable during the walk, if the page detaches
      // it while the browser lays the page out.
      return;
    }
    for (let index = 0; index < count; index++) {
      if (out.length >= MAX_TREE_NODES) return;
      let child: Window | undefined;
      try {
        child = parent.frames[index];
      } catch {
        continue;
      }
      if (child === undefined) continue;
      out.push(child);
      walk(child, depth + 1);
    }
  };

  walk(root, 0);
  return out;
};

/**
 * Is this an order to announce ourselves again?
 *
 * Both messages of `platform/Realm.ts` do that here. The difference is what
 * they do to a frame that has *not* started: the guard honours the wake message
 * and starts the application, and it ignores the announce message. The
 * coordinator therefore sweeps with the announce message, and only a hint round
 * uses the wake message.
 *
 * A frame that already belongs to the session answers neither of them. Read the
 * note at the call site.
 */
const isAnnounceRequest = (data: unknown): boolean => {
  if (typeof data !== "object" || data === null) return false;
  const raw = data as Record<string, unknown>;
  if (raw["magic"] !== WAKE_MESSAGE.magic || raw["v"] !== WAKE_MESSAGE.v) {
    return false;
  }
  return raw["kind"] === WAKE_MESSAGE.kind ||
    raw["kind"] === ANNOUNCE_MESSAGE.kind;
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** One admitted child frame, as the coordinator holds it. */
interface FrameRecord {
  readonly frameId: FrameId;
  readonly source: Window;
  readonly port: MessagePort;
  /** Closes the port and removes its listener. */
  readonly release: Effect.Effect<void>;
}

/** A token that was issued to one window, and that can be used once. */
interface Challenge {
  readonly source: Window;
  readonly issuedAt: number;
}

/** One handshake attempt of a child frame. */
interface Attempt {
  readonly helloId: string;
  readonly port: MessagePort;
  readonly release: Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class FrameBus extends Context.Service<FrameBus, {
  /** This frame's identity on the wire. */
  readonly frameId: FrameId;
  readonly isTop: boolean;

  /**
   * True when this frame belongs to a session.
   *
   * It gives `false` after the deadline, and it does not fail. A frame with no
   * coordinator is a supported configuration, and not an error: an ancestor can
   * be cross-origin with no injection, or a parent can be sandboxed.
   */
  readonly ready: Effect.Effect<boolean>;

  /** Every message that reached this frame and passed every check. */
  readonly incoming: Stream.Stream<InboundMessage>;

  /** Send to one peer. */
  readonly send: (
    target: FrameTarget,
    message: FrameMessage,
  ) => Effect.Effect<void, FrameError>;

  /** Send to every frame that this frame can reach. */
  readonly broadcast: (
    message: FrameMessage,
  ) => Effect.Effect<void, FrameError>;

  /**
   * Send a request and wait for the matching reply, or time out.
   *
   * `decode` reads the answer out of a reply that carries the correlation id.
   * A reply that it does not accept is ignored, and the wait continues until
   * the deadline.
   */
  readonly request: <A>(
    target: FrameTarget,
    message: FrameMessage,
    decode: (reply: InboundMessage) => Option.Option<A>,
    timeout: Duration.Input,
  ) => Effect.Effect<A, FrameError>;

  /**
   * Answer one kind of request for as long as the scope is open.
   *
   * The handler gives `Option.none()` when there is nothing to answer. A reply
   * goes back to the sender with the correlation id of the request.
   */
  readonly serve: <R>(
    kind: MessageKind,
    handler: (
      message: InboundMessage,
    ) => Effect.Effect<Option.Option<FrameMessage>, never, R>,
  ) => Effect.Effect<void, never, R | Scope.Scope>;

  /** The frames that the coordinator knows, in document order. */
  readonly peers: Effect.Effect<ReadonlyArray<FrameId>>;
}>()("vimium/frames/FrameBus") {
  static readonly layer: Layer.Layer<
    FrameBus,
    never,
    Dom | Realm | FrameAuth
  > = Layer.effect(
    FrameBus,
    Effect.gen(function*() {
      const dom = yield* Dom;
      const realm = yield* Realm;
      const auth = yield* FrameAuth;
      const layerScope = yield* Effect.scope;

      const inbox = yield* PubSub.unbounded<InboundMessage>();
      const nonceRef = yield* Ref.make(Option.none<string>());
      const rosterRef = yield* Ref.make<ReadonlyArray<FrameId>>([
        realm.frameId,
      ]);
      const admitted = yield* Deferred.make<boolean>();

      /**
       * A random identity of 128 bits.
       *
       * `None` when the realm has no usable random source. Every send then
       * fails and every routed message is dropped, because a guessable nonce is
       * worse than no session at all.
       */
      const randomId = dom.probeOr(() => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Option.some(
          Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
            "",
          ),
        );
      }, Option.none<string>());

      const freshId: Effect.Effect<string, FrameError> = Effect.flatMap(
        randomId,
        (id) =>
          Option.isSome(id) ? Effect.succeed(id.value) : Effect.fail(
            new FrameError({
              reason: "failed",
              detail: "this realm has no random source",
            }),
          ),
      );

      // ---------------------------------------------------------------------
      // Delivery
      // ---------------------------------------------------------------------

      const publishLocal = (wire: FrameWire): Effect.Effect<void> =>
        Effect.sync(() => {
          PubSub.publishUnsafe(inbox, {
            from: asFrameId(wire.from),
            requestId: wire.requestId === NO_REQUEST_ID
              ? Option.none()
              : Option.some(wire.requestId),
            message: wire,
          });
        });

      /**
       * Hand one message to a port.
       *
       * A post to a port whose document is gone does not throw, and the message
       * is dropped in silence. Liveness is therefore the work of the sweep, and
       * every request has a deadline in any case. Only a payload that the
       * browser cannot clone fails here, and every payload of ours is plain
       * data.
       */
      const postTo = (
        port: MessagePort,
        message: FrameWire | WelcomeMessage,
      ): Effect.Effect<void, FrameError> =>
        Effect.try({
          try: () => {
            port.postMessage(message);
          },
          catch: (cause) =>
            new FrameError({
              reason: "failed",
              detail: `the port refused the message: ${describe(cause)}`,
            }),
        });

      // ---------------------------------------------------------------------
      // The registry of the coordinator
      // ---------------------------------------------------------------------

      const records = yield* Effect.acquireRelease(
        Ref.make<ReadonlyArray<FrameRecord>>([]),
        (ref) =>
          Effect.flatMap(
            Ref.getAndSet(ref, []),
            (open) =>
              Effect.forEach(open, (record) => record.release, {
                discard: true,
              }),
          ),
      );

      const wireFor = (
        message: FrameMessage,
        to: string,
        requestId: string,
      ): Effect.Effect<FrameWire, FrameError> =>
        Effect.flatMap(
          Ref.get(nonceRef),
          (nonce) =>
            Option.isNone(nonce)
              ? Effect.fail(
                new FrameError({
                  reason: "unauthenticated",
                  detail: "this frame is not admitted to a session",
                }),
              )
              : Effect.succeed(
                encodeMessage(
                  { nonce: nonce.value, from: realm.frameId, to, requestId },
                  message,
                ),
              ),
        );

      const postAll = (
        open: ReadonlyArray<FrameRecord>,
        wire: FrameWire,
      ): Effect.Effect<void> =>
        Effect.forEach(
          open.filter((record) => record.frameId !== wire.from),
          (record) => Effect.ignore(postTo(record.port, wire)),
          { discard: true },
        );

      /**
       * Drop the records whose window has left the frames tree, and give back
       * the rest in document order.
       *
       * A post to a dead port does not throw, so "the post failed" is not a
       * signal that we ever receive. The frames tree is the reliable signal: a
       * record whose window is no longer reachable from the root is dead. The
       * sweep runs whenever the roster is read, which is cheap, and which is
       * exactly when the answer matters.
       */
      const sweep: Effect.Effect<ReadonlyArray<FrameRecord>> = Effect.gen(
        function*() {
          const windows = collectFrameWindows(dom.window);
          const order = new Map<Window, number>();
          windows.forEach((view, index) => {
            order.set(view, index);
          });

          const current = yield* Ref.get(records);
          const live = current.filter((record) => order.has(record.source));
          const dead = current.filter((record) => !order.has(record.source));

          const ordered = [...live].sort((left, right) => {
            const leftOrder = order.get(left.source) ?? MAX_TREE_NODES;
            const rightOrder = order.get(right.source) ?? MAX_TREE_NODES;
            if (leftOrder !== rightOrder) return leftOrder - rightOrder;
            return left.frameId < right.frameId ? -1 : 1;
          });

          if (dead.length > 0) {
            yield* Ref.set(records, ordered);
            yield* Effect.forEach(dead, (record) => record.release, {
              discard: true,
            });
            yield* publishRoster(ordered);
          }
          return ordered;
        },
      );

      const rosterOf = (
        open: ReadonlyArray<FrameRecord>,
      ): ReadonlyArray<FrameId> => [
        // The top frame is first, because it is the root document.
        realm.frameId,
        ...open.map((record) => record.frameId),
      ];

      const publishRoster = (
        open: ReadonlyArray<FrameRecord>,
      ): Effect.Effect<void> =>
        Effect.flatMap(
          Effect.result(
            wireFor(
              { kind: "ROSTER", frames: rosterOf(open) },
              WIRE_TARGET_ALL,
              NO_REQUEST_ID,
            ),
          ),
          (built) =>
            Result.isSuccess(built)
              ? postAll(open, built.success)
              : Effect.void,
        );

      // ---------------------------------------------------------------------
      // Routing
      // ---------------------------------------------------------------------

      /**
       * Route one message in the top frame.
       *
       * The same function serves a message of this frame and a message that a
       * child asked us to relay. `from` has already been checked against the
       * port that carried it.
       */
      const routeInTop = Effect.fn("FrameBus.route")(function*(
        wire: FrameWire,
      ) {
        const open = yield* sweep;

        if (wire.to === WIRE_TARGET_ALL) {
          yield* postAll(open, wire);
          // A message of this frame does not come back to this frame.
          if (wire.from !== realm.frameId) yield* publishLocal(wire);
          return;
        }

        if (wire.to === WIRE_TARGET_TOP || wire.to === realm.frameId) {
          yield* publishLocal(wire);
          return;
        }

        const target = open.find((record) => record.frameId === wire.to);
        if (target === undefined) {
          return yield* new FrameError({
            reason: "no-peer",
            detail: `no frame with the id ${wire.to}`,
          });
        }
        yield* postTo(target.port, wire);
      });

      const attemptRef = yield* Effect.acquireRelease(
        Ref.make(Option.none<Attempt>()),
        (ref) =>
          Effect.flatMap(
            Ref.getAndSet(ref, Option.none<Attempt>()),
            (attempt) =>
              Option.isNone(attempt) ? Effect.void : attempt.value.release,
          ),
      );

      /** Route one message in a child frame. The port goes to the coordinator. */
      const routeInChild = Effect.fn("FrameBus.route")(function*(
        wire: FrameWire,
      ) {
        const attempt = yield* Ref.get(attemptRef);
        if (Option.isNone(attempt)) {
          return yield* new FrameError({
            reason: "no-peer",
            detail: "this frame has no link to the top frame",
          });
        }
        yield* postTo(attempt.value.port, wire);
      });

      const route = realm.isTop ? routeInTop : routeInChild;

      const post = Effect.fn("FrameBus.send")(function*(
        target: FrameTarget,
        message: FrameMessage,
        requestId: Option.Option<string>,
      ) {
        const to = target._tag === "Top"
          ? WIRE_TARGET_TOP
          : target._tag === "All"
          ? WIRE_TARGET_ALL
          : target.frameId;
        const wire = yield* wireFor(
          message,
          to,
          Option.getOrElse(requestId, () => NO_REQUEST_ID),
        );
        yield* route(wire);
      });

      const send = (
        target: FrameTarget,
        message: FrameMessage,
      ): Effect.Effect<void, FrameError> =>
        post(target, message, Option.none());

      // ---------------------------------------------------------------------
      // The coordinator: admission
      // ---------------------------------------------------------------------

      const challenges = yield* Ref.make<ReadonlyMap<string, Challenge>>(
        new Map(),
      );

      /**
       * Is `source` a window of our frames tree?
       *
       * Window identity does not prove that the sender is our code, because a
       * `srcdoc` frame of the page is in the tree by right. It does prove that
       * the sender is a frame of this page, and it rules out the window of the
       * coordinator itself.
       */
      const knownWindow = (
        source: unknown,
      ): Effect.Effect<Option.Option<Window>> =>
        dom.probeOr(() => {
          if (source === null || source === undefined) {
            return Option.none<Window>();
          }
          for (const candidate of collectFrameWindows(dom.window)) {
            if (candidate === source) return Option.some(candidate);
          }
          return Option.none<Window>();
        }, Option.none<Window>());

      const expireChallenges = Effect.gen(function*() {
        const now = yield* dom.now;
        yield* Ref.update(challenges, (open) => {
          const next = new Map(open);
          for (const [token, challenge] of next) {
            if (now - challenge.issuedAt > CHALLENGE_TTL_MS) next.delete(token);
          }
          return next;
        });
      });

      /**
       * Issue a token to exactly one window.
       *
       * `targetOrigin` is the origin of the frame that announced itself, taken
       * from the event and not guessed. No other document can then read the
       * token, and above all not the top page, which an unrestricted `"*"`
       * would allow on a same-origin child.
       */
      const challenge = Effect.fn("FrameBus.challenge")(function*(
        source: Window,
        origin: string,
      ) {
        yield* expireChallenges;
        const open = yield* Ref.get(challenges);
        if (open.size >= MAX_PENDING_CHALLENGES) return;

        const token = yield* randomId;
        if (Option.isNone(token)) return;
        const issuedAt = yield* dom.now;
        yield* Ref.update(challenges, (current) => {
          const next = new Map(current);
          next.set(token.value, { source, issuedAt });
          return next;
        });

        yield* Effect.ignore(dom.attempt("Window.postMessage", () => {
          source.postMessage(
            { ...ENVELOPE, kind: "CHALLENGE", token: token.value },
            targetOrigin(origin),
          );
        }));
      });

      const removeRecord = Effect.fn("FrameBus.removeRecord")(function*(
        frameId: FrameId,
      ) {
        const current = yield* Ref.get(records);
        const gone = current.filter((record) => record.frameId === frameId);
        if (gone.length === 0) return;
        const left = current.filter((record) => record.frameId !== frameId);
        yield* Ref.set(records, left);
        yield* Effect.forEach(gone, (record) => record.release, {
          discard: true,
        });
        yield* publishRoster(left);
      });

      /**
       * Read one message that came over the port of an admitted frame.
       *
       * The check of `from` runs before anything acts on the message. The port
       * identifies the sender, so a frame can only speak for itself. To
       * attribute a message to a frame that did not send it would break the
       * order that every frame must agree on.
       */
      const receiveFromChild = (
        frameId: FrameId,
        data: unknown,
      ): Effect.Effect<void> =>
        Effect.gen(function*() {
          const nonce = yield* Ref.get(nonceRef);
          const parsed = parseWire(data, nonce);
          if (Option.isNone(parsed)) return;
          const wire = parsed.value;
          if (wire.from !== frameId) return;

          if (wire.kind === "GOODBYE") {
            yield* removeRecord(frameId);
            return;
          }
          yield* Effect.ignore(routeInTop(wire));
        });

      /**
       * Add one frame to the registry, and welcome it.
       *
       * The port, its listener and the entry live in one scope. To remove the
       * entry is to close that scope, so there is nothing else to remember.
       */
      const admit = Effect.fn("FrameBus.admit")(function*(
        port: MessagePort,
        source: Window,
        frameId: FrameId,
        helloId: string,
      ) {
        const current = yield* Ref.get(records);

        // An identity belongs to one window. A frame that claims the identity
        // of another live frame is refused, because the coordinator would
        // otherwise deliver that frame's messages to it.
        const conflict = current.find((record) =>
          record.frameId === frameId && record.source !== source
        );
        if (conflict !== undefined) {
          yield* Effect.sync(() => {
            port.close();
          });
          return;
        }

        // The same window that joins again is a reload or a restore from the
        // back-forward cache, and not a new frame. Its old record goes.
        const previous = current.filter((record) => record.source === source);
        const rest = current.filter((record) => record.source !== source);
        yield* Effect.forEach(previous, (record) => record.release, {
          discard: true,
        });

        const scope = yield* Scope.make();
        const release = Effect.andThen(
          Effect.sync(() => {
            port.close();
          }),
          Scope.close(scope, Exit.void),
        );

        yield* Scope.provide(
          Effect.gen(function*() {
            yield* dom.listenOn(
              port,
              "message",
              (event) =>
                receiveFromChild(frameId, (event as MessageEvent).data),
            );
            // `messageerror` is the only failure event that a port gives. A
            // payload that cannot be cloned means that the peer is not the code
            // that we expect.
            yield* dom.listenOn(port, "messageerror", () => {
              return Effect.ignore(removeRecord(frameId));
            });
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                port.start();
              }),
              () =>
                Effect.sync(() => {
                  port.close();
                }),
            );
          }),
          scope,
        );

        const record: FrameRecord = { frameId, source, port, release };
        const next = [...rest, record];
        yield* Ref.set(records, next);

        const nonce = yield* Ref.get(nonceRef);
        if (Option.isSome(nonce)) {
          yield* Effect.ignore(postTo(port, {
            ...ENVELOPE,
            kind: "WELCOME",
            nonce: nonce.value,
            frameId,
            helloId,
            frames: rosterOf(next),
          }));
        }
        yield* publishRoster(next);
      });

      /**
       * Finish a join that passed the cheap checks.
       *
       * The proof is checked before anything is registered. It proves that the
       * frame can read manager-private storage, which page code cannot do.
       */
      const completeJoin = Effect.fn("FrameBus.completeJoin")(function*(
        port: MessagePort,
        source: Window,
        message: JoinMessage,
      ) {
        const payload = joinProofPayload(
          message.token,
          message.helloId,
          message.frameId,
        );
        const proven = yield* Effect.orElseSucceed(
          auth.verify(payload, message.proof),
          () => false,
        );
        const stillThere = yield* knownWindow(source);
        if (!proven || Option.isNone(stillThere)) {
          yield* Effect.sync(() => {
            port.close();
          });
          return;
        }
        yield* admit(port, source, asFrameId(message.frameId), message.helloId);
      });

      /**
       * The half of the handshake that runs on `window`.
       *
       * A `HELLO` earns a challenge, and a `JOIN` redeems one. The two steps
       * are what let the port travel to a known `targetOrigin`, and what bind
       * the port to the window that announced itself. One `HELLO` with a port
       * could do neither.
       */
      const onTopWindowMessage = (event: MessageEvent): Effect.Effect<void> =>
        Effect.gen(function*() {
          const parsed = parseWindowToTop(event.data);
          if (Option.isNone(parsed)) return;
          const message = parsed.value;

          const source = yield* knownWindow(event.source);
          if (Option.isNone(source)) return;

          if (message.kind === "HELLO") {
            yield* challenge(source.value, event.origin);
            return;
          }

          const open = yield* Ref.get(challenges);
          const issued = open.get(message.token);
          // One use, whether or not the token turns out to be redeemable.
          yield* Ref.update(challenges, (current) => {
            const next = new Map(current);
            next.delete(message.token);
            return next;
          });
          if (issued === undefined || issued.source !== source.value) return;
          const now = yield* dom.now;
          if (now - issued.issuedAt > CHALLENGE_TTL_MS) return;

          const port = event.ports[0];
          if (port === undefined) return;

          // The proof needs Web Crypto, which is asynchronous. The listener
          // must not suspend, so the rest runs in a fiber of the layer scope.
          yield* Effect.forkIn(
            completeJoin(port, source.value, message),
            layerScope,
          );
        });

      // ---------------------------------------------------------------------
      // The child: the handshake
      // ---------------------------------------------------------------------

      const topWindow: Effect.Effect<Option.Option<Window>> = dom.probeOr(
        () => {
          const view = dom.window.top;
          // `top === self` in a frame that says it is not the top means that
          // the frame was detached after it started. There is nobody to give a
          // port to.
          return view === null || view === dom.window
            ? Option.none<Window>()
            : Option.some(view);
        },
        Option.none<Window>(),
      );

      const announce: Effect.Effect<void> = Effect.gen(function*() {
        const top = yield* topWindow;
        if (Option.isNone(top)) return;
        yield* Effect.ignore(dom.attempt("Window.postMessage", () => {
          // `"*"` is correct here, and only here. We do not know the origin of
          // the top frame yet, and to learn it is what the answer is for. The
          // payload says "I exist", which every frame of the page can see in
          // any case.
          top.value.postMessage({ ...ENVELOPE, kind: "HELLO" }, "*");
        }));
      });

      /** The id of the attempt that was welcomed, so a repeat is ignored. */
      const welcomedRef = yield* Ref.make(Option.none<string>());

      const onWelcome = (data: unknown): Effect.Effect<void> =>
        Effect.gen(function*() {
          const parsed = parseWelcome(data);
          if (Option.isNone(parsed)) return;
          const welcome = parsed.value;

          const attempt = yield* Ref.get(attemptRef);
          // A welcome that we did not ask for, or one for an attempt that a
          // later attempt replaced, is a race or a spoof. It must not re-key
          // this frame.
          if (Option.isNone(attempt)) return;
          if (welcome.helloId !== attempt.value.helloId) return;
          // The coordinator must have recorded the identity that we claimed.
          if (welcome.frameId !== realm.frameId) return;

          const welcomed = yield* Ref.get(welcomedRef);
          if (
            Option.isSome(welcomed) && welcomed.value === attempt.value.helloId
          ) {
            return;
          }

          yield* Ref.set(welcomedRef, Option.some(attempt.value.helloId));
          yield* Ref.set(nonceRef, Option.some(welcome.nonce));
          yield* Ref.set(rosterRef, welcome.frames.map(asFrameId));
          yield* Deferred.succeed(admitted, true);
        });

      const receiveFromTop = (data: unknown): Effect.Effect<void> =>
        Effect.gen(function*() {
          const kind = peekKind(data);
          if (Option.isNone(kind)) return;
          if (kind.value === "WELCOME") {
            yield* onWelcome(data);
            return;
          }

          const nonce = yield* Ref.get(nonceRef);
          const parsed = parseWire(data, nonce);
          if (Option.isNone(parsed)) return;
          const wire = parsed.value;

          // The roster is transport state, so the bus keeps it. Every other
          // service reads it through `peers`.
          if (wire.kind === "ROSTER") {
            yield* Ref.set(rosterRef, wire.frames.map(asFrameId));
          }
          yield* publishLocal(wire);
        });

      /**
       * One attempt to join the session.
       *
       * Each attempt needs a new `MessageChannel`, because `port2` cannot be
       * transferred twice. The attempt that was open before is closed here, so
       * one child frame never holds two ports.
       */
      const startAttempt = Effect.fn("FrameBus.join")(function*(
        token: string,
        origin: string,
      ) {
        const top = yield* topWindow;
        if (Option.isNone(top)) return;

        const helloId = yield* randomId;
        if (Option.isNone(helloId)) return;

        const payload = joinProofPayload(
          token,
          helloId.value,
          realm.frameId,
        );
        const signed = yield* Effect.result(auth.sign(payload));
        if (Result.isFailure(signed)) {
          // No credential means no admission. A frame that cannot read
          // manager-private storage must stay outside the session.
          yield* Effect.logDebug(
            `frame join is not possible: ${signed.failure.detail}`,
          );
          return;
        }

        const built = yield* Effect.result(
          dom.attempt("MessageChannel", () => new MessageChannel()),
        );
        if (Result.isFailure(built)) return;
        const channel = built.success;

        const scope = yield* Scope.make();
        yield* Scope.provide(
          Effect.gen(function*() {
            yield* dom.listenOn(
              channel.port1,
              "message",
              (event) => receiveFromTop((event as MessageEvent).data),
            );
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                channel.port1.start();
              }),
              () =>
                Effect.sync(() => {
                  channel.port1.close();
                }),
            );
          }),
          scope,
        );

        const previous = yield* Ref.getAndSet(
          attemptRef,
          Option.some<Attempt>({
            helloId: helloId.value,
            port: channel.port1,
            release: Scope.close(scope, Exit.void),
          }),
        );
        if (Option.isSome(previous)) yield* previous.value.release;

        yield* Effect.ignore(dom.attempt("Window.postMessage", () => {
          top.value.postMessage(
            {
              ...ENVELOPE,
              kind: "JOIN",
              token,
              helloId: helloId.value,
              frameId: realm.frameId,
              proof: signed.success,
            },
            // The origin that the challenge came from, so the port cannot go to
            // a document that only happens to be at `window.top` now.
            targetOrigin(origin),
            [channel.port2],
          );
        }));
      });

      const onChildWindowMessage = (
        event: MessageEvent,
      ): Effect.Effect<void> =>
        Effect.gen(function*() {
          if (isAnnounceRequest(event.data)) {
            // Only an ancestor may wake a frame. A page could otherwise make
            // every frame that it can reach start a handshake at will.
            if (!(yield* realm.isAncestor(event.source))) return;
            // A frame that already holds the session says nothing. A second
            // handshake makes a second `MessageChannel`, and the port of the
            // attempt before it is closed. A hint round runs on that port, and
            // the round starts with the same wake message that would ask for
            // the new handshake, so the answer of this frame and the `ACTIVATE`
            // of the top frame would both be dropped. A frame that is not
            // admitted still announces itself, which is the recovery that the
            // sweep of the coordinator exists for.
            const nonce = yield* Ref.get(nonceRef);
            if (Option.isSome(nonce)) return;
            yield* announce;
            return;
          }

          const parsed = parseChallenge(event.data);
          if (Option.isNone(parsed)) return;

          // Only the top frame may challenge us. A sibling, or the script of
          // the page, could otherwise make this frame transfer a port to an
          // origin of its choice.
          const top = yield* topWindow;
          if (Option.isNone(top) || event.source !== top.value) return;

          yield* Effect.forkIn(
            startAttempt(parsed.value.token, event.origin),
            layerScope,
          );
        });

      // ---------------------------------------------------------------------
      // Wiring
      // ---------------------------------------------------------------------

      if (realm.isTop) {
        // The coordinator owns the session nonce. It never travels except in a
        // `WELCOME`, which goes over a port that only an admitted frame holds.
        const created = yield* randomId;
        yield* Ref.set(nonceRef, created);

        // Registration is accepted at any time and for ever. `document-start`
        // is not reliable on WebKit, a page inserts frames after load, and a
        // restore from the back-forward cache runs the handshake again. There
        // is no window of time to close.
        yield* dom.listen("window", "message", onTopWindowMessage);

        // A frame that started before this listener existed hears nothing.
        // Ask every descendant that is already running to announce itself
        // again. This must not be the wake message: a sweep with that message
        // would build the whole application in every frame of the page, which
        // is the cost that the guard exists to avoid.
        yield* realm.askDescendantsToAnnounce;
      } else {
        yield* dom.listen("window", "message", onChildWindowMessage);

        // Safari puts a page with an `unload` handler in the back-forward cache
        // and never runs `unload`, so `pagehide` and `pageshow` are the only
        // correct signals.
        yield* dom.listen("window", "pagehide", (event) =>
          // A page that is kept is suspended, and not gone. To say goodbye
          // would leave the restored page outside the session.
          event.persisted
            ? Effect.void
            : Effect.ignore(send(toTop, { kind: "GOODBYE" })));

        yield* dom.listen("window", "pageshow", (event) =>
          // A restore brings back a document whose port the coordinator has
          // already swept. To announce again is cheap, and the registry gives
          // this frame the same identity, because the identity is ours.
          event.persisted ? announce : Effect.void);

        const handshake = Effect.gen(function*() {
          yield* announce;
          for (const delay of HANDSHAKE_RETRY_MS) {
            yield* Effect.sleep(delay);
            yield* announce;
          }
        });

        // The race ends the retries as soon as the welcome lands.
        yield* Effect.forkScoped(
          Effect.asVoid(Effect.race(Deferred.await(admitted), handshake)),
        );
      }

      // ---------------------------------------------------------------------
      // The interface
      // ---------------------------------------------------------------------

      const incoming = Stream.fromPubSub(inbox);

      const peers: Effect.Effect<ReadonlyArray<FrameId>> = realm.isTop
        ? Effect.map(sweep, rosterOf)
        : Effect.map(
          Ref.get(rosterRef),
          (roster) => roster.length > 0 ? roster : [realm.frameId],
        );

      const request = Effect.fn("FrameBus.request")(function*<A>(
        target: FrameTarget,
        message: FrameMessage,
        decode: (reply: InboundMessage) => Option.Option<A>,
        timeout: Duration.Input,
      ) {
        return yield* Effect.scoped(Effect.gen(function*() {
          // Subscribe before the send, so a fast answer cannot arrive between
          // the two steps and be lost.
          const replies = yield* PubSub.subscribe(inbox);
          const requestId = yield* freshId;
          yield* post(target, message, Option.some(requestId));

          const wait = Effect.gen(function*() {
            while (true) {
              const reply = yield* PubSub.take(replies);
              if (
                Option.isNone(reply.requestId) ||
                reply.requestId.value !== requestId
              ) {
                continue;
              }
              const decoded = decode(reply);
              if (Option.isSome(decoded)) return decoded.value;
            }
          });

          return yield* Effect.timeoutOrElse(wait, {
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new FrameError({
                  reason: "timeout",
                  detail: `no answer to ${message.kind} inside the deadline`,
                }),
              ),
          });
        }));
      });

      const serve = Effect.fn("FrameBus.serve")(function*<R>(
        kind: MessageKind,
        handler: (
          message: InboundMessage,
        ) => Effect.Effect<Option.Option<FrameMessage>, never, R>,
      ) {
        yield* Effect.forkScoped(
          Stream.runForEach(
            Stream.filter(incoming, (message) => message.message.kind === kind),
            (message) =>
              Effect.flatMap(
                handler(message),
                (reply) =>
                  Option.isNone(reply) ? Effect.void : Effect.ignore(
                    post(toFrame(message.from), reply.value, message.requestId),
                  ),
              ),
          ),
        );
      });

      return FrameBus.of({
        frameId: realm.frameId,
        isTop: realm.isTop,
        ready: realm.isTop ? Effect.succeed(true) : Effect.timeoutOrElse(
          Deferred.await(admitted),
          { duration: REQUEST_DEADLINE, orElse: () => Effect.succeed(false) },
        ),
        incoming,
        send,
        broadcast: (message) => post(toAll, message, Option.none()),
        request,
        serve,
        peers,
      });
    }),
  );
}
