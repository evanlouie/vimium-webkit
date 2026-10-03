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
 * service answers one kind of message with `serve`, and asks with `request`.
 * Two services that need each other therefore do not import each other, and
 * the layer graph stays a tree.
 *
 * ## The port is not the capability
 *
 * A page reads every `message` event that a window of the page receives, so it
 * takes a copy of the port that a `JOIN` transfers. Every message on a port is
 * therefore sealed with a key that both ends derive from the manager-private
 * credential and from the three values of the handshake. Read
 * `frames/Auth.ts`. The `WELCOME` is the first sealed message, so a page can
 * neither read the session nor forge an admission.
 *
 * Each link holds one counter for each direction. A message that arrives with a
 * counter that is not greater than the last one is dropped before it is opened,
 * so a message cannot be played again. A link has one outbox and one mailbox,
 * and one fiber for each. A caller therefore never waits for Web Crypto, which
 * matters because a hint activation leaves from inside a `keydown` listener,
 * and because each queue keeps the order that the counters need.
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
  Array,
  Boolean,
  Context,
  Data,
  Deferred,
  type Duration,
  Effect,
  Exit,
  flow,
  HashMap,
  Layer,
  Match,
  Option,
  Order,
  Predicate,
  PubSub,
  Queue,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
  pipe,
} from "effect";
import { describeThrown } from "~/domain/Failure.ts";
import type { FrameId } from "~/domain/FrameId.ts";
import {
  type ChallengeMessage,
  challengeMessage,
  encodeLinkMessage,
  encodeMessage,
  type FrameMessage,
  type FrameWire,
  helloMessage,
  joinMessage,
  type JoinMessage,
  MAX_SEAL_SEQUENCE,
  type MessageKind,
  type MessageOf,
  NO_REQUEST_ID,
  parseChallenge,
  parseSealed,
  parseWelcome,
  parseWindowToTop,
  parseWire,
  peekKind,
  REQUEST_DEADLINE_MS,
  type SealDirection,
  type SealedMessage,
  welcomeMessage,
  type WelcomeMessage,
  type WindowToTopMessage,
  WIRE_TARGET_ALL,
  WIRE_TARGET_TOP,
} from "~/domain/FrameMessage.ts";
import { type NoFields, whenSome } from "~/domain/Prelude.ts";
import { Dom } from "~/platform/Dom.ts";
import {
  ANNOUNCE_MESSAGE,
  descendantFrames,
  FrameRole,
  randomHex,
  Realm,
  WAKE_MESSAGE,
} from "~/platform/Realm.ts";
import { FrameAuth, type FrameCipher } from "./Auth.ts";

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
 * How long a handshake attempt of a child frame waits for its welcome before
 * it counts as failed.
 *
 * The top frame answers a join in a few milliseconds. A new attempt closes the
 * port of the attempt before it, and a request that the top frame sent on that
 * port is lost, so an attempt that can still succeed must not be replaced. The
 * deadline is shorter than the last retry of the handshake, so a join that the
 * top frame dropped is tried again on the retry schedule, and later on the
 * next wake.
 */
const ATTEMPT_DEADLINE_MS = 1000;

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

/** The ceiling on the joins that wait for admission. */
export const MAX_PENDING_JOINS = 16;

/**
 * The greatest number of sealed messages that one link holds.
 *
 * Page code holds a copy of the port that a `JOIN` transfers, so page code
 * decides how fast messages arrive. One fiber opens one message at a time, and
 * every open waits for Web Crypto. An unbounded mailbox would therefore let a
 * page fill the memory of the tab with messages of 4 MB each.
 *
 * A full mailbox drops the new message. A flood then costs bounded memory, and
 * it can push out a true message. That is a denial of service, and the holder
 * of the port has that power in any case. A gap in the counter is safe, because
 * the receiver only asks the counter to rise.
 */
export const MAILBOX_CAPACITY = 256;

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
  /** There is no frame with that identity, or there is no link to the top. */
  "no-peer",
  /** The browser refused the post. */
  "failed",
]);

export type FrameFailureReason = typeof FrameFailureReason.Type;

export class FrameError extends Schema.TaggedError<FrameError>()("FrameError", {
  reason: FrameFailureReason,
  detail: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Targets and inbound messages
// ---------------------------------------------------------------------------

export type FrameTarget = Data.TaggedEnum<{
  Top: NoFields;
  All: NoFields;
  Frame: { readonly frameId: FrameId };
}>;

export const FrameTarget = Data.taggedEnum<FrameTarget>();

/** The coordinator. In the top frame this is the frame itself. */
export const toTop: FrameTarget = FrameTarget.Top();

/** Every frame that this frame can reach, and not this frame. */
export const toAll: FrameTarget = FrameTarget.All();

export const toFrame = (frameId: FrameId): FrameTarget => FrameTarget.Frame({ frameId });

/** One message that reached this frame and passed every check. */
export interface InboundMessage {
  /** The frame that sent it. The coordinator checked this against the port. */
  readonly from: FrameId;
  /** The correlation id, when the message is a request or a reply. */
  readonly requestId: Option.Option<string>;
  readonly message: FrameMessage;
}

/** One inbound message of one kind. `serve` gives its handler this type. */
export interface InboundOf<K extends MessageKind> extends InboundMessage {
  readonly message: MessageOf<K>;
}

const isInboundOf =
  <K extends MessageKind>(kind: K) =>
  (inbound: InboundMessage): inbound is InboundOf<K> =>
    inbound.message.kind === kind;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The origin to post to.
 *
 * An opaque origin, which a `srcdoc`, a sandboxed and a `data:` frame reports,
 * is the text `"null"`, and that is not a valid `targetOrigin`. Those frames
 * are reachable through `"*"` only, and they are also the frames whose origin
 * we could not authenticate in any case.
 */
const targetOrigin = (origin: string): string =>
  pipe(
    Match.value(origin),
    Match.whenOr("null", "", () => "*"),
    Match.orElse(() => origin),
  );

/** Read the text of an opened message. A text that is not JSON is dropped. */
const readJson = (text: string): Option.Option<unknown> =>
  pipe(
    Result.try((): unknown => JSON.parse(text)),
    Result.getSuccess,
  );

/** The JSON text of an encoded message. */
const jsonText = (encoded: unknown): Option.Option<string> =>
  pipe(
    Result.try(() => JSON.stringify(encoded)),
    Result.getSuccess,
  );

/**
 * The JSON text of an outbound message, in its wire shape.
 *
 * A message that does not encode, or that has no text, is not sent.
 */
const serialize: (message: FrameWire | WelcomeMessage) => Option.Option<string> = flow(
  encodeLinkMessage,
  Option.flatMap(jsonText),
  Option.filter((text) => text.length > 0),
);

/** The other direction of travel. */
const opposite = (direction: SealDirection): SealDirection =>
  pipe(
    Match.value(direction),
    Match.withReturnType<SealDirection>(),
    Match.when("up", () => "down"),
    Match.when("down", () => "up"),
    Match.exhaustive,
  );

/** The `to` field of a message for one target. */
const wireTarget: (target: FrameTarget) => string = FrameTarget.$match({
  Top: () => WIRE_TARGET_TOP,
  All: () => WIRE_TARGET_ALL,
  Frame: ({ frameId }) => frameId,
});

/** A routed message as the subscribers of this frame read it. */
const inboundOf = (wire: FrameWire): InboundMessage => ({
  from: wire.from,
  requestId: pipe(
    wire.requestId,
    Option.liftPredicate((id) => id !== NO_REQUEST_ID),
  ),
  message: wire,
});

const closePort = (port: MessagePort): Effect.Effect<void> =>
  Effect.sync(() => {
    port.close();
  });

// ---------------------------------------------------------------------------
// The link of one port
// ---------------------------------------------------------------------------

/**
 * One sealed port.
 *
 * The link owns the counter of each direction, the order of what it sends and
 * the fiber that opens what arrives. Nothing outside it touches the port.
 *
 * `send` does not suspend and does not fail. It puts the message in the outbox
 * of the link, and one fiber seals it and posts it. That order is the order of
 * the counter, and it is also what keeps the key path synchronous: a hint
 * activation and a relayed keystroke leave from inside a `keydown` listener,
 * and Web Crypto is asynchronous.
 *
 * A caller therefore learns nothing at the moment of the send. A port that is
 * closed, a seal that fails and a link that reached its counter ceiling all
 * look the same: the message goes, and no answer comes back. The deadline of
 * `request` is the only failure signal that a caller now gets.
 */
export interface Link {
  readonly send: (message: FrameWire | WelcomeMessage) => Effect.Effect<void>;
}

/**
 * Hand one sealed message to a port.
 *
 * A post to a port whose document is gone does not throw, and the message is
 * dropped in silence. Liveness is therefore the work of the sweep, and every
 * request has a deadline in any case. Only a payload that the browser cannot
 * clone fails here, and a sealed message is one string and one number.
 */
const postTo = (port: MessagePort, message: SealedMessage): Effect.Effect<void, FrameError> =>
  Effect.try({
    try: () => {
      port.postMessage(message);
    },
    catch: (cause) =>
      new FrameError({
        reason: "failed",
        detail: `the port refused the message: ${describeThrown(cause)}`,
      }),
  });

/**
 * What a link needs from the browser: one listener on a port.
 *
 * The `Dom` service satisfies it. A test can satisfy it as well, without a
 * document.
 */
export interface PortHost {
  readonly listenOn: Dom["Service"]["listenOn"];
}

/**
 * Build the link of one port.
 *
 * `outbound` is the direction that this frame sends in. The link opens what
 * arrives in the other direction, so a message that is sent back to its sender
 * never opens. A message of another link, or one that a holder of the port kept
 * and sent again, does not open either.
 *
 * The link uses two fibers and two queues. It uses no lock. One fiber seals
 * what the outbox holds, and one fiber opens what the mailbox holds. Each queue
 * keeps its order, so the counters and the wire always agree, and neither the
 * caller nor the listener ever waits for Web Crypto.
 *
 * The port, its listener and the two fibers belong to the enclosing scope. To
 * close that scope is to close the link.
 */
export const makeSealedLink = Effect.fn("FrameBus.link")(function* (
  host: PortHost,
  port: MessagePort,
  cipher: FrameCipher,
  outbound: SealDirection,
  receive: (data: unknown) => Effect.Effect<void>,
) {
  const inbound = opposite(outbound);
  const nextSeq = yield* Ref.make(0);
  const lastSeen = yield* Ref.make(-1);
  const outbox = yield* Queue.unbounded<FrameWire | WelcomeMessage>();
  // A ceiling, because page code holds a copy of the port and can flood it.
  const mailbox = yield* Queue.dropping<SealedMessage>(MAILBOX_CAPACITY);

  /** Post one sealed message. A port that refuses it is a peer that never answers. */
  const postSealed = (sealed: SealedMessage): Effect.Effect<void> =>
    pipe(postTo(port, sealed), Effect.ignore);

  const sealText = (seq: number, text: string): Effect.Effect<void> =>
    pipe(
      cipher.seal(outbound, seq, text),
      Effect.flatMap(postSealed),
      Effect.catch((error) => Effect.logDebug(`could not seal a message: ${error.detail}`)),
    );

  /** Seal one message with its counter, and post it. */
  const sealAt = (seq: number, message: FrameWire | WelcomeMessage): Effect.Effect<void> =>
    pipe(
      serialize(message),
      whenSome((text) => sealText(seq, text)),
    );

  const sealAndPost = Effect.fnUntraced(function* (message: FrameWire | WelcomeMessage) {
    const seq = yield* pipe(
      nextSeq,
      Ref.modify((current) => [current, current + 1]),
    );
    yield* pipe(
      seq > MAX_SEAL_SEQUENCE,
      Boolean.match({
        // The link goes quiet here, and it stays quiet. It is not closed: the
        // frame keeps its record and its port, and every later request of a
        // caller fails at its deadline. The state is safe, because no
        // initialisation vector repeats.
        onTrue: () => Effect.logDebug("this link has sent as many messages as it may"),
        onFalse: () => sealAt(seq, message),
      }),
    );
  });

  const open = Effect.fnUntraced(
    function* (sealed: SealedMessage) {
      // A counter that does not rise is a message that we have already seen, or
      // one that a holder of the port kept and sent again. A message that the
      // full mailbox dropped leaves a gap. A gap is safe: the counter only has
      // to rise, and a page cannot seal the message that fills the gap.
      yield* pipe(
        Ref.get(lastSeen),
        Effect.filterOrFail((last) => sealed.seq > last),
      );
      const text = yield* pipe(
        cipher.open(inbound, sealed),
        Effect.orElseSucceed(() => Option.none<string>()),
        Effect.flatMap(Effect.fromOption),
      );
      yield* pipe(lastSeen, Ref.set(sealed.seq));
      const data = yield* pipe(readJson(text), Effect.fromOption);
      yield* receive(data);
    },
    Effect.catchNoSuchElement,
    Effect.asVoid,
  );

  /**
   * Put one sealed message in the mailbox.
   *
   * A full mailbox drops the new message and says so. To wait here is not a
   * choice: the listener must not suspend, and a page that holds the port
   * would otherwise decide how much memory this tab uses.
   */
  const deliver = (sealed: SealedMessage): Effect.Effect<void> =>
    pipe(
      Effect.sync(() => Queue.offerUnsafe(mailbox, sealed)),
      Effect.flatMap(
        Boolean.match({
          onTrue: () => Effect.void,
          onFalse: () =>
            Effect.logDebug("the mailbox of this link is full, so a message is dropped"),
        }),
      ),
    );

  yield* pipe(Queue.take(outbox), Effect.flatMap(sealAndPost), Effect.forever, Effect.forkScoped);
  yield* pipe(Queue.take(mailbox), Effect.flatMap(open), Effect.forever, Effect.forkScoped);

  yield* host.listenOn(port, "message", (event) =>
    Effect.suspend(() => pipe(event.data, parseSealed, whenSome(deliver))),
  );

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      port.start();
    }),
    () => closePort(port),
  );

  return {
    send: (message) =>
      Effect.sync(() => {
        Queue.offerUnsafe(outbox, message);
      }),
  } satisfies Link;
});

// ---------------------------------------------------------------------------
// The roles
// ---------------------------------------------------------------------------

/**
 * What a role adds to the transport.
 *
 * The role of a realm never changes, so the layer chooses one when it is
 * built. The coordinator holds the registry, the challenges and the joins that
 * wait. A member holds its attempt, its roster and its admission. Neither one
 * allocates the state of the other.
 */
interface Role {
  /** Deliver one message of this frame. The message already has its envelope. */
  readonly route: (wire: FrameWire) => Effect.Effect<void, FrameError>;
  readonly peers: Effect.Effect<ReadonlyArray<FrameId>>;
  readonly joinedFrames: Effect.Effect<ReadonlyArray<Window>>;
  readonly ready: Effect.Effect<boolean>;
}

/** Give one routed message to the subscribers of this frame. */
type PublishLocal = (wire: FrameWire) => Effect.Effect<void>;

/**
 * A random identity of 128 bits.
 *
 * `None` when the realm has no usable random source. The coordinator then
 * issues no token, a child makes no attempt and a request fails, because a
 * guessable identity is worse than no session at all.
 */
const randomId = (dom: Dom["Service"]): Effect.Effect<Option.Option<string>> =>
  dom.probeOrElse(() => Option.some(randomHex(16)), Option.none);

/** One message of `from`, in its envelope. */
const wireOf = (
  from: FrameId,
  target: FrameTarget,
  requestId: string,
  message: FrameMessage,
): FrameWire => encodeMessage({ from, to: wireTarget(target), requestId }, message);

// ---------------------------------------------------------------------------
// The coordinator
// ---------------------------------------------------------------------------

/** One admitted child frame, as the coordinator holds it. */
interface FrameRecord {
  readonly frameId: FrameId;
  readonly source: Window;
  readonly link: Link;
  /** Closes the port and removes its listener. */
  readonly release: Effect.Effect<void>;
}

/** A token that was issued to one window, and that can be used once. */
interface Challenge {
  readonly source: Window;
  readonly issuedAt: number;
}

/** A `JOIN` that passed the cheap checks and waits for its proof to be read. */
interface PendingJoin {
  readonly port: MessagePort;
  readonly source: Window;
  readonly message: JoinMessage;
}

/** A join whose proof holds, which the coordinator now registers. */
interface Admission {
  readonly port: MessagePort;
  readonly source: Window;
  readonly frameId: FrameId;
  readonly helloId: string;
  readonly cipher: FrameCipher;
}

/** Take one token out of the open challenges, whether or not it is redeemable. */
const takeChallenge =
  (token: string) =>
  (
    open: HashMap.HashMap<string, Challenge>,
  ): readonly [Option.Option<Challenge>, HashMap.HashMap<string, Challenge>] => [
    pipe(open, HashMap.get(token)),
    pipe(open, HashMap.remove(token)),
  ];

/** A record with the place of its window in the frames tree. */
interface Placed {
  readonly record: FrameRecord;
  readonly position: number;
}

const byPosition: Order.Order<Placed> = pipe(
  Order.Number,
  Order.mapInput(({ position }: Placed) => position),
);

const byPlacedFrameId: Order.Order<Placed> = pipe(
  Order.String,
  Order.mapInput(({ record }: Placed) => record.frameId),
);

const inDocumentOrder: Order.Order<Placed> = pipe(byPosition, Order.combine(byPlacedFrameId));

/**
 * Split the records into the ones whose window is still in the frames tree,
 * in document order, and the ones whose window has left it.
 *
 * The positions are in a native `Map`, because its keys are windows. An Effect
 * `HashMap` hashes a key by reading its properties, and a cross-origin window
 * refuses that read with an exception.
 */
const inTreeOrder = (
  records: ReadonlyArray<FrameRecord>,
  windows: ReadonlyArray<Window>,
): { readonly live: ReadonlyArray<FrameRecord>; readonly dead: ReadonlyArray<FrameRecord> } => {
  const positions = new Map(
    pipe(
      windows,
      Array.map((view, index) => [view, index] as const),
    ),
  );
  const [placed, dead] = pipe(
    records,
    Array.partition((record) =>
      pipe(
        positions.get(record.source),
        Option.fromNullishOr,
        Option.map((position): Placed => ({ record, position })),
        Result.fromOption(() => record),
      ),
    ),
  );
  const live = pipe(
    placed,
    Array.sort(inDocumentOrder),
    Array.map(({ record }) => record),
  );
  return { live, dead };
};

/** Where the coordinator delivers one routed message. */
type Delivery = Data.TaggedEnum<{
  /** To every other frame, and to this frame unless this frame sent it. */
  Everyone: NoFields;
  /** To this frame only. */
  Here: NoFields;
  /** To one other frame. */
  Peer: { readonly frameId: string };
}>;

const Delivery = Data.taggedEnum<Delivery>();

/** Read the `to` field of a routed message, in the frame `self`, which is the top frame. */
const deliveryOf = (to: string, self: FrameId): Delivery =>
  pipe(
    Match.value(to),
    Match.withReturnType<Delivery>(),
    Match.when(WIRE_TARGET_ALL, () => Delivery.Everyone()),
    Match.when(
      (value) => value === WIRE_TARGET_TOP || value === self,
      () => Delivery.Here(),
    ),
    Match.orElse((frameId) => Delivery.Peer({ frameId })),
  );

/**
 * The role of the top frame.
 *
 * It admits the frames of the page, holds one sealed link for each, and relays
 * between them. Its own messages go through the same routing, so a message to
 * the top frame reaches its subscribers in the same way from every frame.
 */
const makeCoordinator = Effect.fnUntraced(function* (publishLocal: PublishLocal) {
  const dom = yield* Dom;
  const realm = yield* Realm;
  const auth = yield* FrameAuth;
  const layerScope = yield* Effect.scope;

  // ---------------------------------------------------------------------
  // The registry
  // ---------------------------------------------------------------------

  const releaseAll: (open: ReadonlyArray<FrameRecord>) => Effect.Effect<void> = Effect.forEach(
    (record: FrameRecord) => record.release,
    { discard: true },
  );

  const noRecords: ReadonlyArray<FrameRecord> = [];
  const records = yield* Effect.acquireRelease(
    Ref.make(noRecords),
    flow(Ref.getAndSet(noRecords), Effect.flatMap(releaseAll)),
  );

  const postAll = (open: ReadonlyArray<FrameRecord>, wire: FrameWire): Effect.Effect<void> =>
    pipe(
      open,
      Array.filter((record) => record.frameId !== wire.from),
      Effect.forEach((record) => record.link.send(wire), { discard: true }),
    );

  const rosterOf: (open: ReadonlyArray<FrameRecord>) => ReadonlyArray<FrameId> = flow(
    Array.map((record: FrameRecord) => record.frameId),
    // The top frame is first, because it is the root document.
    Array.prepend(realm.frameId),
  );

  const publishRoster = (open: ReadonlyArray<FrameRecord>): Effect.Effect<void> =>
    postAll(
      open,
      wireOf(realm.frameId, toAll, NO_REQUEST_ID, { kind: "ROSTER", frames: rosterOf(open) }),
    );

  /** Keep `kept` as the registry, close the links of `gone`, and tell the frames. */
  const retire = Effect.fnUntraced(function* (
    kept: ReadonlyArray<FrameRecord>,
    gone: ReadonlyArray<FrameRecord>,
  ) {
    yield* pipe(records, Ref.set(kept));
    yield* releaseAll(gone);
    yield* publishRoster(kept);
  });

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
  const sweep: Effect.Effect<ReadonlyArray<FrameRecord>> = Effect.gen(function* () {
    const windows = descendantFrames(dom.window);
    const current = yield* Ref.get(records);
    const { live, dead } = inTreeOrder(current, windows);
    yield* pipe(
      dead,
      Array.match({
        onEmpty: () => Effect.void,
        onNonEmpty: (gone) => retire(live, gone),
      }),
    );
    return live;
  });

  // ---------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------

  /** A message of this frame does not come back to this frame. */
  const publishFromPeer = (wire: FrameWire): Effect.Effect<void> =>
    pipe(
      wire.from === realm.frameId,
      Boolean.match({
        onTrue: () => Effect.void,
        onFalse: () => publishLocal(wire),
      }),
    );

  const forward = (
    open: ReadonlyArray<FrameRecord>,
    frameId: string,
    wire: FrameWire,
  ): Effect.Effect<void, FrameError> =>
    pipe(
      open,
      Array.findFirst((record) => record.frameId === frameId),
      Effect.fromOption(
        () =>
          new FrameError({
            reason: "no-peer",
            detail: `no frame with the id ${frameId}`,
          }),
      ),
      Effect.flatMap((record) => record.link.send(wire)),
    );

  /**
   * Route one message in the top frame.
   *
   * The same function serves a message of this frame and a message that a
   * child asked us to relay. `from` has already been checked against the
   * port that carried it.
   */
  const route = Effect.fn("FrameBus.route")(function* (wire: FrameWire) {
    const open = yield* sweep;
    return yield* pipe(
      deliveryOf(wire.to, realm.frameId),
      Delivery.$match({
        Everyone: () => pipe(postAll(open, wire), Effect.andThen(publishFromPeer(wire))),
        Here: () => publishLocal(wire),
        Peer: ({ frameId }) => forward(open, frameId, wire),
      }),
    );
  });

  // ---------------------------------------------------------------------
  // Admission
  // ---------------------------------------------------------------------

  const challenges = yield* Ref.make(HashMap.empty<string, Challenge>());

  /**
   * Is `source` a window of our frames tree?
   *
   * Window identity does not prove that the sender is our code, because a
   * `srcdoc` frame of the page is in the tree by right. It does prove that
   * the sender is a frame of this page, and it rules out the window of the
   * coordinator itself.
   */
  const knownWindow = (source: unknown): Effect.Effect<Option.Option<Window>> =>
    dom.probeOrElse(
      () =>
        pipe(
          source,
          Option.fromNullishOr,
          Option.flatMap((sender) =>
            pipe(
              descendantFrames(dom.window),
              Array.findFirst((candidate) => candidate === sender),
            ),
          ),
        ),
      Option.none,
    );

  const expireChallenges = Effect.gen(function* () {
    const now = yield* dom.now;
    yield* pipe(
      challenges,
      Ref.update(
        HashMap.filter((challenge: Challenge) => now - challenge.issuedAt <= CHALLENGE_TTL_MS),
      ),
    );
  });

  /**
   * Issue a token to exactly one window.
   *
   * `targetOrigin` is the origin of the frame that announced itself, taken
   * from the event and not guessed. No other document can then read the
   * token, and above all not the top page, which an unrestricted `"*"`
   * would allow on a same-origin child.
   *
   * A full map of open challenges, and a realm with no random source, give
   * no token.
   */
  const challenge = Effect.fn("FrameBus.challenge")(
    function* (source: Window, origin: string) {
      yield* expireChallenges;
      yield* pipe(
        Ref.get(challenges),
        Effect.filterOrFail((open) => HashMap.size(open) < MAX_PENDING_CHALLENGES),
      );
      const token = yield* pipe(randomId(dom), Effect.flatMap(Effect.fromOption));
      const issuedAt = yield* dom.now;
      yield* pipe(challenges, Ref.update(HashMap.set(token, { source, issuedAt })));
      yield* pipe(
        dom.attempt("Window.postMessage", () => {
          source.postMessage(challengeMessage(token), targetOrigin(origin));
        }),
        Effect.ignore,
      );
    },
    Effect.catchNoSuchElement,
    Effect.asVoid,
  );

  const removeRecord = Effect.fn("FrameBus.removeRecord")(function* (frameId: FrameId) {
    const current = yield* Ref.get(records);
    const gone = pipe(
      current,
      Array.filter((record) => record.frameId === frameId),
    );
    const left = pipe(
      current,
      Array.filter((record) => record.frameId !== frameId),
    );
    yield* pipe(
      gone,
      Array.match({
        onEmpty: () => Effect.void,
        onNonEmpty: (closing) => retire(left, closing),
      }),
    );
  });

  /** Act on one routed message of a child. A `GOODBYE` removes the child. */
  const actOnChild =
    (frameId: FrameId) =>
    (wire: FrameWire): Effect.Effect<void> =>
      pipe(
        Match.value(wire),
        Match.when({ kind: "GOODBYE" }, () => removeRecord(frameId)),
        Match.orElse((routed) => pipe(route(routed), Effect.ignore)),
      );

  /**
   * Read one message that a child frame sent on its link.
   *
   * The link has already opened the message, so the sender holds the
   * credential. The check of `from` runs before anything acts on the
   * message. The link identifies the sender, so a frame can only speak for
   * itself. To attribute a message to a frame that did not send it would
   * break the order that every frame must agree on.
   */
  const receiveFromChild = (frameId: FrameId, data: unknown): Effect.Effect<void> =>
    pipe(
      parseWire(data),
      Option.filter((wire) => wire.from === frameId),
      whenSome(actOnChild(frameId)),
    );

  /** The link of one child, which a `messageerror` removes. */
  const childLink = Effect.fnUntraced(function* (
    port: MessagePort,
    frameId: FrameId,
    cipher: FrameCipher,
  ) {
    const link = yield* makeSealedLink(dom, port, cipher, "down", (data) =>
      receiveFromChild(frameId, data),
    );
    // `messageerror` is the only failure event that a port gives. A
    // payload that cannot be cloned means that the peer is not the code
    // that we expect.
    yield* dom.listenOn(port, "messageerror", () => pipe(removeRecord(frameId), Effect.ignore));
    return link;
  });

  /**
   * Add one frame to the registry, and welcome it.
   *
   * The port, its listener and the entry live in one scope. To remove the
   * entry is to close that scope, so there is nothing else to remember.
   */
  const register = Effect.fnUntraced(function* (
    current: ReadonlyArray<FrameRecord>,
    { port, source, frameId, helloId, cipher }: Admission,
  ) {
    // The same window that joins again is a reload or a restore from the
    // back-forward cache, and not a new frame. Its old record goes.
    const previous = pipe(
      current,
      Array.filter((record) => record.source === source),
    );
    const rest = pipe(
      current,
      Array.filter((record) => record.source !== source),
    );
    yield* releaseAll(previous);

    const scope = yield* Scope.make();
    const release = pipe(closePort(port), Effect.andThen(Scope.close(scope, Exit.void)));
    const link = yield* pipe(childLink(port, frameId, cipher), Scope.provide(scope));

    const record: FrameRecord = { frameId, source, link, release };
    const next: ReadonlyArray<FrameRecord> = pipe(rest, Array.append(record));

    // The welcome goes into the outbox before the record is published, so
    // no routed message can go ahead of it on the link.
    yield* link.send(welcomeMessage({ frameId, helloId, frames: rosterOf(next) }));
    yield* pipe(records, Ref.set(next));
    yield* publishRoster(next);
  });

  const admit = Effect.fn("FrameBus.admit")(function* (admission: Admission) {
    const current = yield* Ref.get(records);
    // An identity belongs to one window. A frame that claims the identity
    // of another live frame is refused, because the coordinator would
    // otherwise deliver that frame's messages to it.
    yield* pipe(
      current,
      Array.findFirst(
        (record) => record.frameId === admission.frameId && record.source !== admission.source,
      ),
      Option.match({
        onSome: () => closePort(admission.port),
        onNone: () => register(current, admission),
      }),
    );
  });

  /**
   * Finish a join that passed the cheap checks.
   *
   * The proof is checked before anything is registered. It proves that the
   * frame can read manager-private storage, which page code cannot do. The
   * key of the link comes from the same credential, so a holder of a copy
   * of the port can neither read the session nor speak in it.
   *
   * A proof that does not hold, a window that left the tree and a key that
   * this frame cannot derive each close the port.
   */
  const completeJoin = Effect.fn("FrameBus.completeJoin")(function* ({
    port,
    source,
    message,
  }: PendingJoin) {
    const handshake = {
      token: message.token,
      helloId: message.helloId,
      frameId: message.frameId,
    };
    yield* pipe(
      auth.verifyJoin(handshake, message.proof),
      Effect.filterOrFail((proven) => proven),
      Effect.andThen(knownWindow(source)),
      Effect.flatMap(Effect.fromOption),
      Effect.andThen(auth.cipher(handshake)),
      Effect.flatMap((cipher) =>
        admit({
          port,
          source,
          frameId: message.frameId,
          helloId: message.helloId,
          cipher,
        }),
      ),
      Effect.catch(() => closePort(port)),
    );
  });

  /**
   * The joins that wait for admission, in the order that they arrived.
   *
   * Order is what makes a repeated handshake safe. A child that announces
   * itself again opens a new attempt, and it closes the port of the attempt
   * before it. The join that arrived last is therefore the only one whose
   * port the child still holds. A fiber for each join could finish them in
   * another order. The last admission would then hold a port that nobody
   * reads. The frame would stay outside the session, and it would not
   * announce itself again, because it already counts itself admitted.
   *
   * The queue slides, so a full queue drops its oldest join and keeps the
   * newest one. That is the same rule again: the newest join of a window is
   * the only one that the child can still read. A queue that dropped the
   * newest join would throw away exactly the join that must win.
   *
   * Page code can send a `JOIN` at any rate, so it can push the join of a
   * true frame out of a full queue. It cannot hold that frame out for ever.
   * Every new join displaces an older one, so a join is never refused, and
   * a flood costs bounded memory. A frame whose join was dropped announces
   * itself again on the retry schedule, and later on each sweep of
   * `askDescendantsToAnnounce`. The cost is one hint round, and not the
   * frame.
   */
  const pendingJoins = yield* Queue.sliding<PendingJoin>(MAX_PENDING_JOINS);

  /**
   * Take the oldest join out of the queue, and close its port.
   *
   * The slide of the queue would drop that record silently, and the port
   * of a dead attempt would stay open. `poll` does not suspend.
   */
  const dropOldestJoin: Effect.Effect<void> = pipe(
    Queue.poll(pendingJoins),
    Effect.flatMap(
      whenSome((oldest) =>
        pipe(
          closePort(oldest.port),
          Effect.andThen(Effect.logDebug("too many joins wait, so the oldest one is dropped")),
        ),
      ),
    ),
  );

  /**
   * Queue one join for the fiber that reads its proof.
   *
   * The proof needs Web Crypto, which is asynchronous, and the listener
   * must not suspend. One fiber finishes the joins, and it takes them in
   * the order that they arrived.
   */
  const enqueueJoin = Effect.fnUntraced(function* (join: PendingJoin) {
    const waiting = yield* Queue.size(pendingJoins);
    yield* pipe(
      waiting >= MAX_PENDING_JOINS,
      Boolean.match({
        onFalse: () => Effect.void,
        onTrue: () => dropOldestJoin,
      }),
    );
    const queued = yield* Effect.sync(() => Queue.offerUnsafe(pendingJoins, join));
    yield* pipe(
      queued,
      Boolean.match({
        onTrue: () => Effect.void,
        onFalse: () =>
          pipe(
            closePort(join.port),
            Effect.andThen(Effect.logDebug("the join queue is closed, so this join is dropped")),
          ),
      }),
    );
  });

  /**
   * Redeem the token of a `JOIN`.
   *
   * The token is used once, whether or not it turns out to be redeemable.
   * It must have been issued to the same window, inside its lifetime, and
   * the `JOIN` must carry a port.
   */
  const redeem = Effect.fnUntraced(function* (
    event: MessageEvent,
    source: Window,
    message: JoinMessage,
  ) {
    const now = yield* dom.now;
    const issued = yield* pipe(challenges, Ref.modify(takeChallenge(message.token)));
    yield* pipe(
      issued,
      Effect.fromOption,
      Effect.filterOrFail(
        (open) => open.source === source && now - open.issuedAt <= CHALLENGE_TTL_MS,
      ),
    );
    const port = yield* pipe(event.ports, Array.head, Effect.fromOption);
    yield* enqueueJoin({ port, source, message });
  });

  const onHandshake = Effect.fnUntraced(
    function* (event: MessageEvent, message: WindowToTopMessage) {
      const source = yield* pipe(knownWindow(event.source), Effect.flatMap(Effect.fromOption));
      yield* pipe(
        Match.value(message),
        Match.discriminatorsExhaustive("kind")({
          HELLO: () => challenge(source, event.origin),
          JOIN: (join) => redeem(event, source, join),
        }),
      );
    },
    Effect.catchNoSuchElement,
    Effect.asVoid,
  );

  /**
   * The half of the handshake that runs on `window`.
   *
   * A `HELLO` earns a challenge, and a `JOIN` redeems one. The two steps
   * are what let the port travel to a known `targetOrigin`, and what bind
   * the port to the window that announced itself. One `HELLO` with a port
   * could do neither.
   */
  const onTopWindowMessage = (event: MessageEvent): Effect.Effect<void> =>
    pipe(
      parseWindowToTop(event.data),
      whenSome((message) => onHandshake(event, message)),
    );

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  // The credential of the session already exists here: `FrameAuth`
  // creates or loads it when its layer is built. That layer is built
  // before this one, so the first child that answers a challenge finds a
  // frame that can verify a proof.
  //
  // One fiber admits the joins, one at a time and in order. See
  // `pendingJoins` for why the order is a requirement, and not a taste.
  yield* pipe(
    Queue.take(pendingJoins),
    Effect.flatMap(completeJoin),
    Effect.forever,
    Effect.forkIn(layerScope),
  );

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

  return {
    route,
    peers: pipe(sweep, Effect.map(rosterOf)),
    joinedFrames: pipe(sweep, Effect.map(Array.map((record) => record.source))),
    // A top frame that cannot hold the credential can admit no frame, so it
    // has no session to wake the page for.
    ready: Effect.succeed(auth.available),
  } satisfies Role;
});

// ---------------------------------------------------------------------------
// The member
// ---------------------------------------------------------------------------

/** The port of one handshake attempt of a child frame. */
type AttemptLink = {
  readonly helloId: string;
  readonly link: Link;
  readonly release: Effect.Effect<void>;
};

/**
 * One handshake attempt of a child frame.
 *
 * `Joining` waits for its welcome until its deadline, and `Joined` has had
 * it. A repeat of the welcome finds `Joined`, and it changes nothing. `Stale`
 * is the link of a frame that the back-forward cache restored: the frame still
 * sends on it, and it asks to join again.
 */
type Attempt = Data.TaggedEnum<{
  Joining: AttemptLink & { readonly deadline: number };
  Joined: AttemptLink;
  Stale: AttemptLink;
}>;

const Attempt = Data.taggedEnum<Attempt>();

/**
 * Whether this frame may start a new handshake at `now`.
 *
 * A new attempt closes the port of the attempt before it, and a request that
 * the top frame sent on that port is lost. A wake that comes twice, or a
 * second challenge, must therefore not start a second handshake while the
 * first one can still succeed. A frame with no attempt, with an attempt past
 * its deadline or with a stale link starts one. A frame that is joining or
 * has joined does not.
 */
const opensAttempt = (now: number): ((current: Option.Option<Attempt>) => boolean) =>
  Option.match({
    onNone: () => true,
    onSome: Attempt.$match({
      Joining: ({ deadline }) => now >= deadline,
      Joined: () => false,
      Stale: () => true,
    }),
  });

/** The attempt of a restored frame, which keeps its link and asks to join again. */
const staleAttempt: (attempt: Attempt) => Attempt = Attempt.$match({
  Joining: ({ helloId, link, release }) => Attempt.Stale({ helloId, link, release }),
  Joined: ({ helloId, link, release }) => Attempt.Stale({ helloId, link, release }),
  Stale: (stale) => stale,
});

/**
 * Accept a welcome for the attempt that is open, once.
 *
 * A welcome that we did not ask for, or one for an attempt that a later
 * attempt replaced, is a race or a spoof. It must not re-key this frame. The
 * coordinator must also have recorded the identity that we claimed. The first
 * value is the welcome that this frame now acts on.
 */
const acceptWelcome =
  (welcome: WelcomeMessage, frameId: FrameId) =>
  (
    current: Option.Option<Attempt>,
  ): readonly [Option.Option<WelcomeMessage>, Option.Option<Attempt>] =>
    pipe(
      current,
      Option.filter(Attempt.$is("Joining")),
      Option.filter(
        (attempt) => attempt.helloId === welcome.helloId && welcome.frameId === frameId,
      ),
      Option.match({
        onNone: () => [Option.none(), current],
        onSome: ({ helloId, link, release }) => [
          Option.some(welcome),
          Option.some(Attempt.Joined({ helloId, link, release })),
        ],
      }),
    );

/**
 * Is this an order to announce ourselves again?
 *
 * Both messages of `platform/Realm.ts` do that here. The difference is what
 * they do to a frame that has *not* started: the guard honours the wake message
 * and starts the application, and it ignores the announce message. The
 * coordinator therefore sweeps with the announce message, and only a hint round
 * uses the wake message.
 *
 * A frame that is joining, or that already belongs to the session, answers
 * neither of them. Read `opensAttempt`.
 */
const isAnnounceRequest = (data: unknown): boolean =>
  Predicate.isObject(data) &&
  data["magic"] === WAKE_MESSAGE.magic &&
  data["v"] === WAKE_MESSAGE.v &&
  (data["kind"] === WAKE_MESSAGE.kind || data["kind"] === ANNOUNCE_MESSAGE.kind);

/**
 * The role of a child frame.
 *
 * It joins the session of the top frame over one sealed link, and it gives
 * every message that it sends to that link. The top frame relays it from
 * there.
 */
const makeMember = Effect.fnUntraced(function* (publishLocal: PublishLocal) {
  const dom = yield* Dom;
  const realm = yield* Realm;
  const auth = yield* FrameAuth;
  const layerScope = yield* Effect.scope;

  const rosterRef = yield* Ref.make<ReadonlyArray<FrameId>>([realm.frameId]);
  const admitted = yield* Deferred.make<boolean>();

  const attemptRef = yield* Effect.acquireRelease(
    Ref.make(Option.none<Attempt>()),
    flow(
      Ref.getAndSet(Option.none<Attempt>()),
      Effect.flatMap(whenSome((attempt) => attempt.release)),
    ),
  );

  /** A member speaks in the session only after its first welcome. */
  const requireAdmission: Effect.Effect<void, FrameError> = pipe(
    Deferred.isDone(admitted),
    Effect.filterOrFail(
      (done) => done,
      () =>
        new FrameError({
          reason: "unauthenticated",
          detail: "this frame is not admitted to a session",
        }),
    ),
    Effect.asVoid,
  );

  /** Route one message in a child frame. The port goes to the coordinator. */
  const route = Effect.fn("FrameBus.route")(function* (wire: FrameWire) {
    yield* requireAdmission;
    const attempt = yield* Ref.get(attemptRef);
    return yield* pipe(
      attempt,
      Effect.fromOption(
        () =>
          new FrameError({
            reason: "no-peer",
            detail: "this frame has no link to the top frame",
          }),
      ),
      Effect.flatMap(({ link }) => link.send(wire)),
    );
  });

  // ---------------------------------------------------------------------
  // The handshake
  // ---------------------------------------------------------------------

  const topWindow: Effect.Effect<Option.Option<Window>> = dom.probeOrElse(
    () =>
      pipe(
        dom.window.top,
        Option.fromNullishOr,
        // `top === self` in a frame that says it is not the top means that
        // the frame was detached after it started. There is nobody to give
        // a port to.
        Option.filter((view) => view !== dom.window),
      ),
    Option.none,
  );

  const postHello = (top: Window): Effect.Effect<void> =>
    pipe(
      dom.attempt("Window.postMessage", () => {
        // `"*"` is correct here, and only here. We do not know the origin of
        // the top frame yet, and to learn it is what the answer is for. The
        // payload says "I exist", which every frame of the page can see in
        // any case.
        top.postMessage(helloMessage, "*");
      }),
      Effect.ignore,
    );

  /** Whether this frame may start a handshake now. Read `opensAttempt`. */
  const mayOpenAttempt: Effect.Effect<boolean> = Effect.gen(function* () {
    const now = yield* dom.now;
    const current = yield* Ref.get(attemptRef);
    return pipe(current, opensAttempt(now));
  });

  /**
   * Say that this frame exists, unless it is joining or has joined.
   *
   * The top frame answers each `HELLO` with a challenge, so a frame that
   * announces itself again only asks for a challenge that it would refuse.
   */
  const announce: Effect.Effect<void> = pipe(
    topWindow,
    Effect.flatMap(whenSome(postHello)),
    Effect.when(mayOpenAttempt),
    Effect.asVoid,
  );

  const joinSession = Effect.fnUntraced(function* (welcome: WelcomeMessage) {
    yield* pipe(rosterRef, Ref.set(welcome.frames));
    yield* pipe(admitted, Deferred.succeed(true));
  });

  const onWelcome = Effect.fnUntraced(function* (welcome: WelcomeMessage) {
    const accepted = yield* pipe(attemptRef, Ref.modify(acceptWelcome(welcome, realm.frameId)));
    yield* pipe(accepted, whenSome(joinSession));
  });

  const receiveWelcome = (data: unknown): Effect.Effect<void> =>
    pipe(parseWelcome(data), whenSome(onWelcome));

  /**
   * Deliver one routed message of the top frame.
   *
   * The roster is transport state, so the bus keeps it. Every other
   * service reads it through `peers`.
   */
  const deliverFromTop = Effect.fnUntraced(function* (wire: FrameWire) {
    yield* pipe(
      Match.value(wire),
      Match.when({ kind: "ROSTER" }, ({ frames }) => pipe(rosterRef, Ref.set(frames))),
      Match.orElse(() => Effect.void),
    );
    yield* publishLocal(wire);
  });

  const receiveRouted = (data: unknown): Effect.Effect<void> =>
    pipe(parseWire(data), whenSome(deliverFromTop));

  /** Read one message that the top frame sent on the link of this frame. */
  const receiveFromTop = (data: unknown): Effect.Effect<void> =>
    pipe(
      peekKind(data),
      Option.exists((kind) => kind === "WELCOME"),
      Boolean.match({
        onTrue: () => receiveWelcome(data),
        onFalse: () => receiveRouted(data),
      }),
    );

  /**
   * One attempt to join the session.
   *
   * Each attempt needs a new `MessageChannel`, because `port2` cannot be
   * transferred twice. The attempt that was open before is closed here, so
   * one child frame never holds two ports.
   */
  const startAttempt = Effect.fn("FrameBus.join")(
    function* (token: string, origin: string) {
      const top = yield* pipe(topWindow, Effect.flatMap(Effect.fromOption));
      const helloId = yield* pipe(randomId(dom), Effect.flatMap(Effect.fromOption));
      const handshake = { token, helloId, frameId: realm.frameId };

      // No credential means no admission. A frame that cannot read
      // manager-private storage must stay outside the session.
      const proof = yield* auth.joinProof(handshake);

      // The same credential gives the key of the port. Both ends derive it
      // from the three values of this attempt, and neither one sends it.
      const cipher = yield* auth.cipher(handshake);

      const channel = yield* dom.attempt("MessageChannel", () => new MessageChannel());
      const scope = yield* Scope.make();
      const link = yield* pipe(
        makeSealedLink(dom, channel.port1, cipher, "up", receiveFromTop),
        Scope.provide(scope),
      );

      const now = yield* dom.now;
      const previous = yield* pipe(
        attemptRef,
        Ref.getAndSet(
          Option.some<Attempt>(
            Attempt.Joining({
              helloId,
              link,
              release: Scope.close(scope, Exit.void),
              deadline: now + ATTEMPT_DEADLINE_MS,
            }),
          ),
        ),
      );
      yield* pipe(
        previous,
        whenSome((attempt) => attempt.release),
      );

      yield* pipe(
        dom.attempt("Window.postMessage", () => {
          top.postMessage(
            joinMessage({ token, helloId, frameId: realm.frameId, proof }),
            // The origin that the challenge came from, so the port cannot go
            // to a document that only happens to be at `window.top` now.
            targetOrigin(origin),
            [channel.port2],
          );
        }),
        Effect.ignore,
      );
    },
    Effect.catchTags({
      FrameAuthError: (error) => Effect.logDebug(`frame join is not possible: ${error.detail}`),
      NoSuchElementError: () => Effect.void,
      DomError: () => Effect.void,
    }),
  );

  /**
   * An order to announce this frame again.
   *
   * Only an ancestor may wake a frame. A page could otherwise make every
   * frame that it can reach start a handshake at will.
   *
   * Every hint round wakes the frames of the page, so the order comes again
   * and again. A frame that is joining or has joined says nothing: a second
   * handshake would close the port that a round runs on. A frame whose
   * attempt failed still announces itself, which is the recovery that the
   * sweep of the coordinator and the wake of a round give.
   */
  const onAnnounceRequest = (source: unknown): Effect.Effect<void> =>
    pipe(announce, Effect.when(realm.isAncestor(source)), Effect.asVoid);

  /** One handshake attempt is prepared at a time. */
  const opening = yield* Semaphore.make(1);

  /**
   * Answer a challenge with a new attempt.
   *
   * Only the top frame may challenge us. A sibling, or the script of the
   * page, could otherwise make this frame transfer a port to an origin of
   * its choice.
   *
   * A frame that is joining or has joined refuses the challenge, and so does
   * a frame that is still preparing an attempt. The top frame answers every
   * `HELLO`, so two announcements give two challenges, and the second one
   * would otherwise close the port of the first attempt.
   */
  const acceptChallenge = Effect.fnUntraced(
    function* (event: MessageEvent, message: ChallengeMessage) {
      yield* pipe(
        topWindow,
        Effect.flatMap(Effect.fromOption),
        Effect.filterOrFail((top) => event.source === top),
      );
      yield* pipe(
        startAttempt(message.token, event.origin),
        Effect.when(mayOpenAttempt),
        Semaphore.withPermitsIfAvailable(opening, 1),
        Effect.forkIn(layerScope),
      );
    },
    Effect.catchNoSuchElement,
    Effect.asVoid,
  );

  const onChallengeMessage = (event: MessageEvent): Effect.Effect<void> =>
    pipe(
      parseChallenge(event.data),
      whenSome((message) => acceptChallenge(event, message)),
    );

  const onChildWindowMessage = (event: MessageEvent): Effect.Effect<void> =>
    pipe(
      isAnnounceRequest(event.data),
      Boolean.match({
        onTrue: () => onAnnounceRequest(event.source),
        onFalse: () => onChallengeMessage(event),
      }),
    );

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  yield* dom.listen("window", "message", onChildWindowMessage);

  // Safari puts a page with an `unload` handler in the back-forward cache
  // and never runs `unload`, so `pagehide` and `pageshow` are the only
  // correct signals.
  yield* dom.listen("window", "pagehide", (event) =>
    // A page that is kept is suspended, and not gone. To say goodbye
    // would leave the restored page outside the session.
    //
    // The message is put in the outbox here, and the fiber of the link
    // seals it. The document usually goes before that happens, so treat
    // `GOODBYE` as a message that does not arrive. The record of this
    // frame then lives in the coordinator until the sweep sees the window
    // leave the frames tree, or until the same window joins again. A
    // frame that navigates in place keeps its window, so its record
    // survives until the new document joins.
    pipe(
      event.persisted,
      Boolean.match({
        onTrue: () => Effect.void,
        onFalse: () =>
          pipe(
            route(wireOf(realm.frameId, toTop, NO_REQUEST_ID, { kind: "GOODBYE" })),
            Effect.ignore,
          ),
      }),
    ),
  );

  yield* dom.listen("window", "pageshow", (event) =>
    // A restore brings back a document whose port the coordinator may have
    // swept. To join again is cheap, and the registry gives this frame the
    // same identity, because the identity is ours. The frame sends on its
    // old link until the new one replaces it.
    pipe(
      event.persisted,
      Boolean.match({
        onTrue: () =>
          pipe(attemptRef, Ref.update(Option.map(staleAttempt)), Effect.andThen(announce)),
        onFalse: () => Effect.void,
      }),
    ),
  );

  const retries = pipe(
    HANDSHAKE_RETRY_MS,
    Effect.forEach((delay) => pipe(announce, Effect.delay(delay)), { discard: true }),
  );
  const handshake = pipe(announce, Effect.andThen(retries));

  // The race ends the retries as soon as the welcome lands.
  yield* pipe(Deferred.await(admitted), Effect.race(handshake), Effect.asVoid, Effect.forkScoped);

  /** A member that has no roster yet knows itself. */
  const roster: Effect.Effect<ReadonlyArray<FrameId>> = pipe(
    Ref.get(rosterRef),
    Effect.map(
      Array.match({
        onEmpty: () => [realm.frameId],
        onNonEmpty: (known: Array.NonEmptyReadonlyArray<FrameId>) => known,
      }),
    ),
  );

  return {
    route,
    peers: roster,
    // The roster names the frames, and only the top frame holds their
    // windows.
    joinedFrames: Effect.succeed([]),
    // A frame that cannot make a proof never joins, so it says so at once.
    ready: pipe(
      auth.available,
      Boolean.match({
        onFalse: () => Effect.succeed(false),
        onTrue: () => Deferred.await(admitted),
      }),
    ),
  } satisfies Role;
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class FrameBus extends Context.Service<
  FrameBus,
  {
    /** This frame's identity on the wire. */
    readonly frameId: FrameId;

    /**
     * The role of the realm, which is also its role in the session.
     *
     * The top frame is the coordinator. It admits every other frame and relays
     * between them. A child frame is a member, which joins the session of the
     * coordinator.
     */
    readonly role: FrameRole;

    /**
     * Wait until this frame belongs to a session, and give `true`.
     *
     * It can wait for ever, and it does not fail. A frame with no coordinator
     * is a supported configuration, and not an error: an ancestor can be
     * cross-origin with no injection, or a parent can be sandboxed. The
     * coordinator also admits a frame whenever it hears it, so a deadline here
     * would turn a late admission into none. A caller that cannot wait races
     * it. A frame that cannot hold the credential gives `false` at once.
     */
    readonly ready: Effect.Effect<boolean>;

    /** Send to one peer. */
    readonly send: (target: FrameTarget, message: FrameMessage) => Effect.Effect<void, FrameError>;

    /** Send to every frame that this frame can reach. */
    readonly broadcast: (message: FrameMessage) => Effect.Effect<void, FrameError>;

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
     * The handler receives the messages of that kind only, already narrowed to
     * it. It gives `Option.none()` when there is nothing to answer. A reply
     * goes back to the sender with the correlation id of the request.
     */
    readonly serve: <K extends MessageKind, R>(
      kind: K,
      handler: (message: InboundOf<K>) => Effect.Effect<Option.Option<FrameMessage>, never, R>,
    ) => Effect.Effect<void, never, R | Scope.Scope>;

    /** The frames that the coordinator knows, in document order. */
    readonly peers: Effect.Effect<ReadonlyArray<FrameId>>;

    /**
     * The windows of the child frames that have joined, in document order.
     *
     * Only the top frame holds them. A child frame gives none.
     */
    readonly joinedFrames: Effect.Effect<ReadonlyArray<Window>>;
  }
>()("vimium/frames/FrameBus") {
  static readonly layer: Layer.Layer<FrameBus, never, Dom | Realm | FrameAuth> = Layer.effect(
    FrameBus,
    Effect.gen(function* () {
      const dom = yield* Dom;
      const realm = yield* Realm;
      const inbox = yield* PubSub.unbounded<InboundMessage>();

      const publishLocal = (wire: FrameWire): Effect.Effect<void> =>
        Effect.sync(() => {
          pipe(inbox, PubSub.publishUnsafe(inboundOf(wire)));
        });

      // The role of the realm is fixed, so it is chosen once, here. The rest
      // of the service is the same in both roles.
      const { route, peers, joinedFrames, ready } = yield* pipe(
        realm.role,
        FrameRole.$match({
          Top: () => makeCoordinator(publishLocal),
          Child: () => makeMember(publishLocal),
        }),
      );

      const freshId: Effect.Effect<string, FrameError> = pipe(
        randomId(dom),
        Effect.flatMap(
          Effect.fromOption(
            () =>
              new FrameError({
                reason: "failed",
                detail: "this realm has no random source",
              }),
          ),
        ),
      );

      const post = Effect.fn("FrameBus.send")(function* (
        target: FrameTarget,
        message: FrameMessage,
        requestId: Option.Option<string>,
      ) {
        const correlation = pipe(
          requestId,
          Option.getOrElse(() => NO_REQUEST_ID),
        );
        yield* route(wireOf(realm.frameId, target, correlation, message));
      });

      const request = Effect.fn("FrameBus.request")(function* <A>(
        target: FrameTarget,
        message: FrameMessage,
        decode: (reply: InboundMessage) => Option.Option<A>,
        timeout: Duration.Input,
      ) {
        return yield* pipe(
          Effect.gen(function* () {
            // Subscribe before the send, so a fast answer cannot arrive between
            // the two steps and be lost.
            const replies = yield* PubSub.subscribe(inbox);
            const requestId = yield* freshId;
            yield* post(target, message, Option.some(requestId));

            /** The answer that one reply carries to this request. */
            const answer = (reply: InboundMessage): Option.Option<A> =>
              pipe(
                reply.requestId,
                Option.filter((id) => id === requestId),
                Option.flatMap(() => decode(reply)),
              );

            return yield* pipe(
              PubSub.take(replies),
              Effect.map(answer),
              Effect.repeat({ until: Option.isSome<A> }),
              Effect.map((found) => found.value),
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () =>
                  Effect.fail(
                    new FrameError({
                      reason: "timeout",
                      detail: `no answer to ${message.kind} inside the deadline`,
                    }),
                  ),
              }),
            );
          }),
          Effect.scoped,
        );
      });

      const serve = Effect.fn("FrameBus.serve")(function* <K extends MessageKind, R>(
        kind: K,
        handler: (message: InboundOf<K>) => Effect.Effect<Option.Option<FrameMessage>, never, R>,
      ) {
        /** Send one answer back to the sender, with the correlation id of the request. */
        const replyTo =
          (inbound: InboundOf<K>) =>
          (reply: FrameMessage): Effect.Effect<void> =>
            pipe(post(toFrame(inbound.from), reply, inbound.requestId), Effect.ignore);

        yield* pipe(
          Stream.fromPubSub(inbox),
          Stream.filter(isInboundOf(kind)),
          Stream.runForEach((inbound) =>
            pipe(handler(inbound), Effect.flatMap(whenSome(replyTo(inbound)))),
          ),
          Effect.forkScoped,
        );
      });

      return FrameBus.of({
        frameId: realm.frameId,
        role: realm.role,
        ready,
        send: (target, message) => post(target, message, Option.none()),
        broadcast: (message) => post(toAll, message, Option.none()),
        request,
        serve,
        peers,
        joinedFrames,
      });
    }),
  );
}
