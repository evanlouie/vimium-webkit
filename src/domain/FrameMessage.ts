/**
 * The cross-frame wire format.
 *
 * Adapted from the frame protocol of Vimium — `content_scripts/
 * vimium_frontend.js` for frame registration and `focusFrame`,
 * `content_scripts/link_hints.js` for the hint descriptors, and
 * `background_scripts/main.js` for the broker. A userscript has no background
 * page, so the top frame is the broker.
 *
 * Everything here is untrusted input. A message comes from `postMessage`, or
 * from a `MessagePort` that a frame we do not control gave us. Each inbound
 * payload is decoded against a schema, and a payload that fails is dropped.
 * There is no "probably correct" route. This module touches no DOM and holds no
 * state, so it stays in `src/domain/`.
 *
 * ## Security posture
 *
 * A hostile page can post a message that looks like our protocol. A page also
 * controls its own `srcdoc` and same-origin frames, and those frames are in the
 * frames tree by right. Window identity proves "a window on this page", and
 * never "our code". A page also reads every `message` event that a window of
 * the page receives, so it takes a copy of the `MessagePort` that a `JOIN`
 * transfers. The protection is therefore in layers:
 *
 * 1. **Authenticated challenge and response.** A `HELLO` is an announcement
 *    only. The coordinator answers with a one-shot token. A `JOIN` must carry
 *    an HMAC over that token, over the hello id and over the frame id. The key
 *    is in manager-private storage. Every injected frame can read it, and page
 *    code cannot.
 * 2. **Targeted transfer.** The challenge tells the child the origin of the
 *    coordinator, so the child transfers the port with a real `targetOrigin`
 *    and not with `"*"`. The port is the capability. To give it to `"*"` is to
 *    give it to whoever answers first.
 * 3. **A sealed port.** Every message on the port is a `SEALED` message. The
 *    two frames derive one AES-GCM key from the credential and from the three
 *    values of the handshake, so the key belongs to one port and to one
 *    attempt. The direction and the counter of each message go into the
 *    associated data and into the initialisation vector. Page code that holds
 *    a copy of the port therefore reads nothing, forges nothing, and cannot
 *    play a message again or send it back.
 * 4. **Authorise, then validate.** `preauthorize` checks the envelope and the
 *    session nonce with a direct property read, before any schema decode. An
 *    unauthorised sender can then not make us validate a large payload.
 * 5. **Nothing with a side effect crosses the wire.** Settings never travel.
 *    Every frame reads its own storage. What travels is the exclusion verdict,
 *    which is two fields, and which must come from the URL of the top frame.
 *
 * A page can read a challenge in the page world. That does not authenticate the
 * page: the challenge holds no manager-private key, and the one-shot token and
 * the hello id in the HMAC stop a replay.
 *
 * ## What changed against the earlier protocol
 *
 * The magic value, the version and the message kinds are the same. The routing
 * fields are now common to every message that travels after the handshake:
 * `from`, `to` and `requestId` sit beside `nonce` in one envelope. The bus can
 * therefore relay any message between two frames without a rule for each kind,
 * which is what keeps the hint logic out of the transport.
 *
 * ## What the hints service must do
 *
 * The transport does not know what a hint round is. It checks the envelope, the
 * session and the sender, and it stops there. `REQUEST_HINTS`,
 * `COLLECT_HINTS`, `HINTS`, `HINTS_RESULT`, `ACTIVATE`, `ACTIVATE_HINT` and
 * `KEYSTROKE` are therefore answered by the hints service, with
 * `FrameBus.serve`. That service owns the rules that the round needs:
 *
 * - One live round for the whole page, with a limit on its age. An admitted
 *   frame could otherwise start detection passes without a limit.
 * - Only the frame that started the live round may drive it, and only once.
 *   `ACTIVATE_HINT` ends in a click, a hover, a focus or a clipboard write
 *   inside a document of another origin, so it is the most consequential
 *   message of the protocol.
 * - A keystroke means something inside a round only, and only from the frame
 *   that the user types into.
 * - A frame speaks for its own hints only. Drop a descriptor whose `frameId` is
 *   not the frame that sent it.
 */

import { Option, Schema } from "effect";
import { FULLY_ENABLED } from "~/domain/Exclusion.ts";

/** The first, cheap test against the other `postMessage` traffic of a page. */
export const PROTOCOL_MAGIC = "vimium-webkit/frames";

/**
 * Raised on any change that is not compatible.
 *
 * Two versions of the script can be in one page. A manager can update between
 * the load of the top frame and the insertion of a late iframe. A version that
 * does not match must therefore be a clean drop, and not a parse failure
 * somewhere deeper.
 */
export const PROTOCOL_VERSION = 2;

/** The number of Vimium, for the reason of Vimium: a dead frame must not hold a mode. */
export const REQUEST_DEADLINE_MS = 3000;

/** The envelope literals. Put them in every outbound message. */
export const ENVELOPE = {
  magic: PROTOCOL_MAGIC,
  v: PROTOCOL_VERSION,
} as const;

/**
 * The two reserved values of the `to` field.
 *
 * A frame id is 16 hexadecimal characters, so a frame id can never be one of
 * these two words.
 */
export const WIRE_TARGET_TOP = "top";
export const WIRE_TARGET_ALL = "all";

/** The `requestId` of a message that is not part of a request. */
export const NO_REQUEST_ID = "";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Ceilings, and not tuning values. They exist so that a hostile frame or a
 * broken frame cannot make us allocate without a limit before we decide to
 * trust it.
 *
 * The sizes come from what the feature uses. A marker shows 40 characters, the
 * filter wants a few more, and a frame that gives five thousand hints is
 * already past the point where hints help the user.
 */
const MAX_ID_LENGTH = 64;
const MAX_LINK_TEXT = 256;

/**
 * The greatest counter that one link accepts.
 *
 * A counter that reaches this value ends the link. A page that draws hints
 * every second needs a year to get there, and a frame that sends a million
 * messages is broken in some other way.
 */
export const MAX_SEAL_SEQUENCE = 1_000_000;

/**
 * The greatest length of a sealed payload, in base64 characters.
 *
 * The largest payload that we send is a full set of descriptors, which is about
 * 1.7 MB of text and about 2.3 MB of base64. This ceiling holds that, and it
 * stops a peer from making us decode more.
 */
const MAX_SEALED_LENGTH = 4_000_000;
const MAX_LOCAL_INDEX = 100_000;
const MAX_DESCRIPTORS = 5_000;
const MAX_NOTATION_LENGTH = 64;
const MAX_PASS_KEYS = 1024;

/** The same ceiling that the walk of the frames tree uses. */
const MAX_FRAMES = 512;

const idSchema = Schema.String.check(Schema.isMaxLength(MAX_ID_LENGTH));

/**
 * An identifier of the handshake: a token, a hello id or a frame id.
 *
 * The alphabet is hexadecimal, because every such value comes from
 * `crypto.getRandomValues`. The restriction is a security control, and not
 * tidiness. `joinProofPayload` and `linkKeyPayload` join their parts with a
 * separator, so a value that could hold a separator or a letter would let one
 * payload spell out the other. A page that can make the child sign a text of
 * its choice could then derive the key of the link. A hexadecimal value can
 * spell neither payload.
 */
const handshakeIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8,64}$/),
);

/** `localIndex` on the wire: an integer with a bound, and never negative. */
const localIndexSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_LOCAL_INDEX }),
);

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

/**
 * What a hint does when the user selects it.
 *
 * The list is here, and not in the hints feature, because the wire carries it.
 * A mode that the wire cannot carry becomes "hints work in this frame only",
 * which is worse than an error.
 */
export const hintModeSchema = Schema.Literals([
  "activate",
  "activate-new-tab",
  "activate-new-tab-background",
  "hover",
  "focus",
  "copy-link-url",
  "copy-link-text",
  "open-with-omnibar",
  "download",
]);

export type HintMode = typeof hintModeSchema.Type;

/** One hint of one frame, as the other frames see it. */
export const hintDescriptorSchema = Schema.Struct({
  frameId: idSchema,
  localIndex: localIndexSchema,
  linkText: Schema.String.check(Schema.isMaxLength(MAX_LINK_TEXT)),
  secondary: Schema.Boolean,
});

export type HintDescriptor = typeof hintDescriptorSchema.Type;

/** `Schema.Array` is already read-only, so there is no second wrapper. */
const descriptorsSchema = Schema.Array(hintDescriptorSchema).check(
  Schema.isMaxLength(MAX_DESCRIPTORS),
);

/**
 * The total order that every frame must agree on.
 *
 * Each frame sorts the merged set of descriptors on its own, and then works out
 * its hint strings from the result. A comparator that differs by one position
 * means that two frames do not agree about what `sa` selects. The hints service
 * must use this function, and no other.
 */
export const compareDescriptors = (
  left: HintDescriptor,
  right: HintDescriptor,
): number =>
  left.frameId === right.frameId
    ? left.localIndex - right.localIndex
    : (left.frameId < right.frameId ? -1 : 1);

/** Sort into the canonical cross-frame order. The input is not changed. */
export const sortDescriptors = (
  descriptors: readonly HintDescriptor[],
): readonly HintDescriptor[] => [...descriptors].sort(compareDescriptors);

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/**
 * The *resolved* exclusion for a page.
 *
 * This is not a stored rule, which is a pattern and a set of pass keys.
 * Upstream resolves an exclusion against the URL of the top frame
 * (`sender.tab.url`), so this is always the answer of the top frame.
 */
export const effectiveExclusionSchema = Schema.Struct({
  enabled: Schema.Boolean,
  passKeys: Schema.String.check(Schema.isMaxLength(MAX_PASS_KEYS)),
});

export type EffectiveExclusion = typeof effectiveExclusionSchema.Type;

/**
 * What a frame uses when the top frame never answers.
 *
 * "Enabled, and no key passed through" is the correct failure mode. A frame
 * that cannot reach the coordinator, because an ancestor is cross-origin with
 * no injection or because a parent is sandboxed, would otherwise disable
 * Vimium-WebKit on a page that the user never excluded.
 */
export const DEFAULT_EXCLUSION: EffectiveExclusion = FULLY_ENABLED;

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

const envelopeShape = () => ({
  magic: Schema.Literal(PROTOCOL_MAGIC),
  v: Schema.Literal(PROTOCOL_VERSION),
});

/**
 * Child to top, over `window.top.postMessage`. An announcement, and no more.
 *
 * It carries no secret, it gives no right, and it transfers no port. A forged
 * `HELLO` therefore costs nothing. The coordinator answers with a `CHALLENGE`
 * that is addressed to the window that announced itself. The port moves in the
 * `JOIN` only.
 */
export const helloSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("HELLO"),
});

/**
 * Top to child, over `window.postMessage`, addressed to one window.
 *
 * The token is one-shot, and it is bound to the window that it was posted to.
 * It is not the session nonce. To read it is not enough, because a `JOIN` must
 * also prove possession of the manager-private credential.
 */
export const challengeSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("CHALLENGE"),
  token: handshakeIdSchema,
});

/**
 * Child to top, over `window.postMessage`, with `port2` transferred.
 *
 * The child sends it with the real origin of the coordinator as
 * `targetOrigin`, which the `CHALLENGE` is what told it. `helloId` is the id of
 * this attempt, and the `WELCOME` must give it back. A stale or forged welcome
 * from a racing sender is then dropped, and it cannot re-key the frame.
 *
 * `frameId` is the identity that this frame will use on the wire. The proof
 * covers it, so a frame that holds no credential cannot claim an identity.
 */
export const joinSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("JOIN"),
  token: handshakeIdSchema,
  helloId: handshakeIdSchema,
  frameId: handshakeIdSchema,
  /** The HMAC over the token, the hello id and the frame id. */
  proof: idSchema,
});

/**
 * Top to child, inside a sealed message on the port. It admits the frame.
 *
 * It carries no settings and no exclusion verdict. The frame asks for the
 * verdict with an `EXCLUSION_REQUEST` when it needs one, and it reads its
 * settings from its own storage.
 *
 * It is the first message of the link, so it proves that the other end holds
 * the credential. A page that copied the port cannot make one.
 */
export const welcomeSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("WELCOME"),
  nonce: handshakeIdSchema,
  /** The identity that the coordinator recorded, which the `JOIN` claimed. */
  frameId: handshakeIdSchema,
  /** It gives back the `JOIN` that earned it. Anything else is a race or a spoof. */
  helloId: handshakeIdSchema,
  frames: Schema.Array(handshakeIdSchema).check(
    Schema.isMaxLength(MAX_FRAMES),
  ),
});

export type HelloMessage = typeof helloSchema.Type;
export type ChallengeMessage = typeof challengeSchema.Type;
export type JoinMessage = typeof joinSchema.Type;
export type WelcomeMessage = typeof welcomeSchema.Type;

/** What the top frame accepts on its `window`. Nothing else is a handshake. */
export const windowToTopSchema = Schema.Union([helloSchema, joinSchema]);

export type WindowToTopMessage = typeof windowToTopSchema.Type;

/**
 * The text that a `JOIN` proof signs.
 *
 * The token stops a replay, the hello id binds the proof to one attempt, and
 * the frame id binds the claimed identity to the holder of the credential.
 */
export const joinProofPayload = (
  token: string,
  helloId: string,
  frameId: string,
): string => `${token}:${helloId}:${frameId}`;

// ---------------------------------------------------------------------------
// The sealed envelope
// ---------------------------------------------------------------------------

/**
 * Which way a sealed message travels.
 *
 * The receiver names the direction that it expects, and it never reads the
 * direction from the wire. A message that is sent back to its sender therefore
 * fails, because the sender opens it with the other direction.
 */
export const SealDirection = Schema.Literals([
  /** Child to top. */
  "up",
  /** Top to child. */
  "down",
]);

export type SealDirection = typeof SealDirection.Type;

/**
 * What travels on a port. It holds one encrypted message, and nothing else.
 *
 * The counter is in clear text, because the receiver needs it to build the
 * initialisation vector and to refuse a message that it has already seen. The
 * counter is also in the associated data, so a peer cannot change it.
 */
export const sealedSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("SEALED"),
  seq: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_SEAL_SEQUENCE }),
  ),
  /** The ciphertext and its tag, in base64 for a URL, with no padding. */
  data: Schema.String.check(Schema.isMaxLength(MAX_SEALED_LENGTH)),
});

export type SealedMessage = typeof sealedSchema.Type;

/**
 * The text that a link key is derived from.
 *
 * The prefix separates this from `joinProofPayload`. The proof travels in
 * clear text, so a derivation that used the same text would publish the key.
 * The prefix holds letters that a handshake identifier cannot hold, and the
 * schema accepts hexadecimal identifiers only, so the two texts can never be
 * the same.
 */
export const linkKeyPayload = (
  token: string,
  helloId: string,
  frameId: string,
): string => `${PROTOCOL_MAGIC}/link/v1:${token}:${helloId}:${frameId}`;

/**
 * The associated data of one sealed message.
 *
 * It binds the protocol, the version, the link, the direction and the counter
 * to the ciphertext. The receiver builds it from what it expects, so a message
 * of another link, another direction or another position fails to open.
 */
export const sealedAad = (
  link: string,
  direction: SealDirection,
  seq: number,
): string =>
  `${PROTOCOL_MAGIC}/${PROTOCOL_VERSION}/${link}/${direction}/${seq}`;

// ---------------------------------------------------------------------------
// The routed messages
// ---------------------------------------------------------------------------

/**
 * The routing fields.
 *
 * `from` is the sender. The coordinator checks it against the port that the
 * message came on, so a frame can only speak for itself. `to` is
 * `WIRE_TARGET_TOP`, `WIRE_TARGET_ALL` or a frame id. `requestId` correlates a
 * reply with its request, and it is `NO_REQUEST_ID` when there is none.
 */
const routedShape = () => ({
  ...envelopeShape(),
  nonce: idSchema,
  from: idSchema,
  to: idSchema,
  requestId: idSchema,
});

const define = <F extends Schema.Struct.Fields>(fields: F) => ({
  payload: Schema.Struct(fields),
  wire: Schema.Struct({ ...routedShape(), ...fields }),
});

/**
 * Top to every frame, after a change of the settings in the top frame.
 *
 * It carries the exclusion verdict, and nothing else. Settings used to travel
 * here. That made the protocol a route to push a CSS string, a search template
 * and a key-mapping source into every frame of a page. It also made the
 * handshake a route to take the exclusion patterns, the mappings and the engine
 * list of the user out of the top frame. Every frame reads its own storage.
 * This message is a prompt to do that, and it is not a source of truth.
 */
const settingsPush = define({
  kind: Schema.Literal("SETTINGS"),
  exclusion: effectiveExclusionSchema,
});

/** Top to every frame, whenever the registry changes. It keeps `peers` honest. */
const roster = define({
  kind: Schema.Literal("ROSTER"),
  frames: Schema.Array(idSchema).check(Schema.isMaxLength(MAX_FRAMES)),
});

/** Origin frame to top: "run a cross-frame hint round for me". */
const requestHints = define({
  kind: Schema.Literal("REQUEST_HINTS"),
  mode: hintModeSchema,
});

/** Top to every frame. */
const collectHints = define({
  kind: Schema.Literal("COLLECT_HINTS"),
  mode: hintModeSchema,
});

/** Frame to top, in answer to `COLLECT_HINTS`. */
const hints = define({
  kind: Schema.Literal("HINTS"),
  descriptors: descriptorsSchema,
});

/**
 * Top to the origin frame, in answer to `REQUEST_HINTS`.
 *
 * The descriptors of the origin are removed from this payload. The origin
 * already holds its heavy local hints, and it works its own descriptors out
 * again from them. Upstream measured that removal as a large gain on a page
 * with many links.
 *
 * The frame that merges the answers must accept a descriptor from the frame
 * that produced it only. A descriptor that is given to the wrong frame breaks
 * the shared order, which is a correctness problem and not only an attack.
 */
const hintsResult = define({
  kind: Schema.Literal("HINTS_RESULT"),
  descriptors: descriptorsSchema,
});

/**
 * Top to every frame except the origin: "a hint session is live, and this is
 * the globally ordered set". Each receiver draws markers for its own hints.
 */
const activate = define({
  kind: Schema.Literal("ACTIVATE"),
  originFrameId: idSchema,
  mode: hintModeSchema,
  descriptors: descriptorsSchema,
});

/**
 * Origin to the owning frame, through the top: "act on one of your hints".
 *
 * The target is the `to` field of the envelope, so the transport relays it. The
 * receiver must check that `from` is the frame that owns the live round.
 *
 * A frame that owns the hint must act on it directly, and must not send this
 * message to itself. `activate-new-tab` and the clipboard modes use the
 * transient activation of the user, and that activation does not survive two
 * `postMessage` steps in Safari.
 */
const activateHint = define({
  kind: Schema.Literal("ACTIVATE_HINT"),
  localIndex: localIndexSchema,
  mode: hintModeSchema,
});

/**
 * Origin to every other frame, through the top.
 *
 * The top relays it, and does not act on it, because only the frame that owns
 * an element holds a live marker to filter.
 */
const keystroke = define({
  kind: Schema.Literal("KEYSTROKE"),
  notation: Schema.String.check(Schema.isMaxLength(MAX_NOTATION_LENGTH)),
});

/** Any frame to top: `gf` and `gF`. */
const focusFrame = define({
  kind: Schema.Literal("FOCUS_FRAME"),
  direction: Schema.Literals([1, -1]),
});

/** Top to the elected frame. */
const takeFocus = define({ kind: Schema.Literal("TAKE_FOCUS") });

/** Frame to top, when its window gains focus. It keeps the `gf` cursor honest. */
const focused = define({ kind: Schema.Literal("FOCUSED") });

/** Child to top. Answered from the URL of the *top* frame. */
const exclusionRequest = define({
  kind: Schema.Literal("EXCLUSION_REQUEST"),
});

const exclusionResult = define({
  kind: Schema.Literal("EXCLUSION_RESULT"),
  exclusion: effectiveExclusionSchema,
});

/**
 * Child to top, on `pagehide`.
 *
 * Best effort only. A frame that the page removes from the document sends
 * nothing, and a post to a dead `MessagePort` does not throw. The registry can
 * therefore not depend on this message. It sweeps the frames tree as well.
 */
const goodbye = define({ kind: Schema.Literal("GOODBYE") });

/**
 * A union, and not a discriminated union, because Effect v4 has no such
 * combinator.
 *
 * `Schema.Union` does index its members by their literal fields, but the index
 * is a union across every such field, and `magic` and `v` are literals that
 * every member shares. Each member therefore stays a candidate, and the members
 * are tried in order.
 *
 * That costs about half a microsecond for each member that is skipped, and it
 * does not weaken the bound that this file cares about. The envelope fields
 * come first, so a member whose `kind` does not match is abandoned at that
 * literal, before the decoder reads `descriptors`. Hostile traffic does not
 * come here at all, because `preauthorize` drops it first.
 */
export const frameMessageSchema = Schema.Union([
  settingsPush.payload,
  roster.payload,
  requestHints.payload,
  collectHints.payload,
  hints.payload,
  hintsResult.payload,
  activate.payload,
  activateHint.payload,
  keystroke.payload,
  focusFrame.payload,
  takeFocus.payload,
  focused.payload,
  exclusionRequest.payload,
  exclusionResult.payload,
  goodbye.payload,
]);

/** The same messages, with the routing envelope, as they travel. */
export const frameWireSchema = Schema.Union([
  settingsPush.wire,
  roster.wire,
  requestHints.wire,
  collectHints.wire,
  hints.wire,
  hintsResult.wire,
  activate.wire,
  activateHint.wire,
  keystroke.wire,
  focusFrame.wire,
  takeFocus.wire,
  focused.wire,
  exclusionRequest.wire,
  exclusionResult.wire,
  goodbye.wire,
]);

/** What a caller gives to the bus. The bus adds the envelope. */
export type FrameMessage = typeof frameMessageSchema.Type;

/** What travels. Every wire message is also a `FrameMessage`. */
export type FrameWire = typeof frameWireSchema.Type;

export type MessageKind = FrameMessage["kind"];

/** `MessageOf<"ROSTER">` reads better than `Extract<...>` at each call site. */
export type MessageOf<K extends MessageKind> = Extract<
  FrameMessage,
  { kind: K }
>;

/** The fields that the bus fills in for the sender. */
export interface WireEnvelope {
  readonly nonce: string;
  readonly from: string;
  readonly to: string;
  readonly requestId: string;
}

/** Put one message in its envelope. Pure, and it never fails. */
export const encodeMessage = (
  envelope: WireEnvelope,
  message: FrameMessage,
): FrameWire => ({ ...ENVELOPE, ...envelope, ...message });

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The decoders are built once, at module load, and used for every message.
 *
 * `Schema.decodeUnknownOption`, and not the `Result` form of
 * `platform/SchemaIo.ts`. Both are synchronous and neither one throws, but this
 * boundary drops the diagnosis in any case. The `Option` form takes `unknown`
 * directly, and it never builds an error message that a hostile page would be
 * paying us to produce.
 */
const decodeWire = Schema.decodeUnknownOption(frameWireSchema);
const decodeWindowToTop = Schema.decodeUnknownOption(windowToTopSchema);
const decodeChallenge = Schema.decodeUnknownOption(challengeSchema);
const decodeWelcome = Schema.decodeUnknownOption(welcomeSchema);
const decodeSealed = Schema.decodeUnknownOption(sealedSchema);

const readEnvelope = (
  data: unknown,
): Option.Option<Record<string, unknown>> => {
  if (typeof data !== "object" || data === null) return Option.none();
  const raw = data as Record<string, unknown>;
  // The magic test is not a security control. It is a cost control, because a
  // busy page posts messages all the time, and a full decode of each one is
  // waste.
  if (raw["magic"] !== PROTOCOL_MAGIC) return Option.none();
  if (raw["v"] !== PROTOCOL_VERSION) return Option.none();
  return Option.some(raw);
};

/**
 * Read the kind of a message without a decode.
 *
 * The caller uses it to choose a decoder. It proves nothing about the payload.
 */
export const peekKind = (data: unknown): Option.Option<string> => {
  const raw = readEnvelope(data);
  if (Option.isNone(raw)) return Option.none();
  const kind = raw.value["kind"];
  return typeof kind === "string" ? Option.some(kind) : Option.none();
};

/**
 * Decide whether a payload is worth a validation, with a direct property read.
 *
 * This runs before the schema decodes the message, and that order is the point.
 * An array of descriptors has a bound, but it is still large, and to validate
 * one for a sender that we were always going to reject gives an attacker our
 * main thread for free. It reads three properties and compares three values.
 *
 * The comparison is not constant time. It does not need to be. The attacker is
 * in the same page, and can already observe our timing more directly.
 */
export const preauthorize = (
  data: unknown,
  expectedNonce: Option.Option<string>,
): boolean => {
  const raw = readEnvelope(data);
  if (Option.isNone(raw)) return false;
  if (Option.isNone(expectedNonce)) return false;
  return raw.value["nonce"] === expectedNonce.value;
};

/**
 * Parse a routed message, and check the session nonce.
 *
 * `expectedNonce` is `None` until this frame is admitted. Every routed message
 * is then rejected, which is correct: a frame that is not admitted has no
 * session to talk in.
 */
export const parseWire = (
  data: unknown,
  expectedNonce: Option.Option<string>,
): Option.Option<FrameWire> => {
  if (!preauthorize(data, expectedNonce)) return Option.none();
  return decodeWire(data);
};

/** Parse a `HELLO` or a `JOIN`. Both come before any nonce exists. */
export const parseWindowToTop = (
  data: unknown,
): Option.Option<WindowToTopMessage> =>
  Option.isNone(readEnvelope(data)) ? Option.none() : decodeWindowToTop(data);

/** Parse a `CHALLENGE`. The caller must first check that the sender is the top frame. */
export const parseChallenge = (
  data: unknown,
): Option.Option<ChallengeMessage> =>
  Option.isNone(readEnvelope(data)) ? Option.none() : decodeChallenge(data);

/** Parse a `WELCOME`. The caller must check the `helloId` of the attempt. */
export const parseWelcome = (data: unknown): Option.Option<WelcomeMessage> =>
  Option.isNone(readEnvelope(data)) ? Option.none() : decodeWelcome(data);

/**
 * Parse the envelope of a sealed message.
 *
 * This says nothing about the payload. The payload is opened with the key of
 * the link, and only then is it parsed.
 */
export const parseSealed = (data: unknown): Option.Option<SealedMessage> =>
  Option.isNone(readEnvelope(data)) ? Option.none() : decodeSealed(data);
