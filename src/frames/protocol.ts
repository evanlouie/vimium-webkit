/**
 * The cross-frame wire format (IMPLEMENTATION_PLAN.md §6.5).
 *
 * Adapted from Vimium's frame protocol — `content_scripts/vimium_frontend.js`
 * (frame registration and `focusFrame`), `content_scripts/link_hints.js`
 * (`getLocalHints` / hint descriptors), and `background_scripts/main.js` (the
 * hint broker that we have to reimplement in the top frame, since a userscript
 * has no background page).
 *
 * Everything here is *untrusted input*. Messages arrive from `postMessage` and
 * from `MessagePort`s handed to us by frames we do not control, so every
 * inbound payload is decoded against a schema and dropped on failure — there is
 * no "probably fine" path. Keep this module free of DOM access so it stays
 * unit-testable without a DOM.
 *
 * ## Security posture
 *
 * A malicious page can post messages that look like our protocol, and — this is
 * the part that is easy to get wrong — a page-controlled `srcdoc` or
 * same-origin iframe is *legitimately* in the frames tree. Window identity
 * proves "a window on this page", never "our code". The layers are therefore:
 *
 * 1. **Authenticated challenge-response admission.** A `HELLO` is only an
 *    announcement. The coordinator answers with a one-shot token. `JOIN` must
 *    carry an HMAC over that token and its hello id. The key lives in manager-
 *    private storage, which every injected frame can read and page code cannot.
 *    The token is also bound to the source window and consumed once.
 * 2. **Targeted transfer.** The challenge tells the child the coordinator's
 *    origin, so the port is transferred with a real `targetOrigin` instead of
 *    `"*"`. The port is the capability; handing it to `"*"` was handing it to
 *    whoever answered first.
 * 3. **Authorize, then validate.** `parseInbound` checks the envelope, the
 *    direction and the nonce by direct property read before any schema decode,
 *    so an unauthorized sender cannot make us validate megabytes of payload.
 * 4. **Nothing with a side effect crosses the wire.** No settings: every frame
 *    reads its own storage. What travels is the exclusion decision, which is
 *    two fields and genuinely has to come from the top frame's URL.
 *
 * A page can read a challenge in page world. That does not authenticate it:
 * the challenge contains no manager-private key, and replay is prevented by
 * the one-shot token and the hello id included in the HMAC.
 */

import { Option, Schema } from "effect";
import type { HintMode, RemoteHintDescriptor } from "~/core/context.ts";

/** Cheap first-pass discriminator against the rest of the page's `postMessage` traffic. */
export const PROTOCOL_MAGIC = "vimium-webkit/frames";

/**
 * Bumped on any incompatible change.
 *
 * Two script versions can genuinely coexist in one page — a manager updates
 * between the top frame's load and a lazily-inserted iframe's — so a version
 * mismatch has to be a clean drop rather than a parse error somewhere deeper.
 */
export const PROTOCOL_VERSION = 2;

/** Vimium's number, and for Vimium's reason: a hung frame must not deadlock a mode. */
export const REQUEST_DEADLINE_MS = 3000;

/** Envelope literals, spread into every outbound message. */
export const ENVELOPE = {
  magic: PROTOCOL_MAGIC,
  v: PROTOCOL_VERSION,
} as const;

const envelopeShape = () => ({
  magic: Schema.Literal(PROTOCOL_MAGIC),
  v: Schema.Literal(PROTOCOL_VERSION),
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Ceilings, not tuning knobs. They exist so that a hostile or broken frame
 * cannot make us allocate without limit before we have decided to trust it.
 *
 * `MAX_LINK_TEXT` and `MAX_DESCRIPTORS` were four and two orders of magnitude
 * above anything real — 20 000 × 1024 is a 20 MB decode — so they are
 * sized against what the feature actually uses: markers render 40 characters,
 * filter matching wants a little more, and a frame contributing five thousand
 * hints is already past the point where hints are usable.
 */
const MAX_ID_LENGTH = 64;
const MAX_LINK_TEXT = 256;
const MAX_LOCAL_INDEX = 100_000;
const MAX_DESCRIPTORS = 5_000;
const MAX_NOTATION_LENGTH = 64;

const idSchema = Schema.String.check(Schema.isMaxLength(MAX_ID_LENGTH));

/** `localIndex` on the wire: a bounded, non-negative integer. */
const localIndexSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_LOCAL_INDEX }),
);

// ---------------------------------------------------------------------------
// Frame ids
// ---------------------------------------------------------------------------

const FRAME_ID_DIGITS = 4;

/**
 * Zero-padded so that lexicographic order equals numeric order.
 *
 * Load-bearing: hint descriptors are sorted by `frameId` *as a string* (see
 * `compareDescriptors` and the matching comparator in
 * `features/hints/index.ts`). With unpadded ids `"10" < "2"`, which is still
 * deterministic but makes `knownFrames()` and the `gf` cursor read as garbage.
 */
export const formatFrameId = (index: number): string =>
  `f${
    Math.max(0, Math.trunc(index)).toString(10).padStart(FRAME_ID_DIGITS, "0")
  }`;

// ---------------------------------------------------------------------------
// Hint modes
// ---------------------------------------------------------------------------

const HINT_MODES = [
  "activate",
  "activate-new-tab",
  "activate-new-tab-background",
  "hover",
  "focus",
  "copy-link-url",
  "copy-link-text",
  "open-with-omnibar",
  "download",
] as const satisfies readonly HintMode[];

export const hintModeSchema = Schema.Literals(HINT_MODES);

/**
 * `false` if `HintMode` has grown a member the wire format cannot carry.
 *
 * Asserted at compile time by `HINT_MODE_COVERAGE` below and at runtime by the
 * unit tests, because a silently un-transportable mode degrades to "hints work
 * in this frame only" rather than to an error.
 */
export type HintModesAreExhaustive = [
  Exclude<HintMode, (typeof HINT_MODES)[number]>,
] extends [never] ? true
  : false;

export const HINT_MODE_COVERAGE: HintModesAreExhaustive = true;

// ---------------------------------------------------------------------------
// Hint descriptors
// ---------------------------------------------------------------------------

export const hintDescriptorSchema = Schema.Struct({
  frameId: idSchema,
  localIndex: localIndexSchema,
  linkText: Schema.String.check(Schema.isMaxLength(MAX_LINK_TEXT)),
  secondary: Schema.Boolean,
});

/** `Schema.Array` is already a `ReadonlyArray`, so no `readonly` wrapper. */
const descriptorsSchema = Schema.Array(hintDescriptorSchema).check(
  Schema.isMaxLength(MAX_DESCRIPTORS),
);

/**
 * The total order every frame must agree on.
 *
 * This *must* stay identical to `byFrameThenIndex` in
 * `features/hints/index.ts`: each frame sorts the merged descriptor set
 * independently and derives its hint strings from the result, so a comparator
 * that disagrees by one position means two frames disagree about what `sa`
 * means.
 */
export const compareDescriptors = (
  a: RemoteHintDescriptor,
  b: RemoteHintDescriptor,
): number =>
  a.frameId === b.frameId
    ? a.localIndex - b.localIndex
    : (a.frameId < b.frameId ? -1 : 1);

/** Non-mutating sort into the canonical cross-frame order. */
export const sortDescriptors = (
  descriptors: readonly RemoteHintDescriptor[],
): readonly RemoteHintDescriptor[] => [...descriptors].sort(compareDescriptors);

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/**
 * The *resolved* exclusion for a page — not a stored `ExclusionRule`, which is
 * a `{pattern, passKeys}` pair. Upstream evaluates exclusions against the top
 * frame's URL (`sender.tab.url`), so this is always the top frame's answer.
 */
export const effectiveExclusionSchema = Schema.Struct({
  enabled: Schema.Boolean,
  passKeys: Schema.String.check(Schema.isMaxLength(1024)),
});

export type EffectiveExclusion = typeof effectiveExclusionSchema.Type;

/**
 * What a frame assumes when the top frame never answers.
 *
 * "Enabled, nothing passed through" is the right failure mode: a frame that
 * cannot reach the coordinator (cross-origin ancestor with no injection, a
 * sandboxed parent) would otherwise silently disable Vimium on a page the user
 * never excluded.
 */
export const DEFAULT_EXCLUSION: EffectiveExclusion = {
  enabled: true,
  passKeys: "",
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Child → top, over `window.top.postMessage`. An announcement, nothing more.
 *
 * It carries no secret, grants nothing, and transfers no port — so it costs
 * nothing if a page forges one. The coordinator answers with a `CHALLENGE`
 * addressed to the announcing window; the port only moves in `JOIN`.
 */
const helloSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("HELLO"),
});

/**
 * Top → child, over `window.postMessage`, addressed to one window.
 *
 * The token is one-shot and bound to the window it was posted to. It is *not*
 * the session nonce. Reading it is insufficient because `JOIN` also proves
 * possession of the manager-private frame credential.
 */
const challengeSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("CHALLENGE"),
  token: idSchema,
});

/**
 * Child → top, over `window.postMessage` with `port2` transferred.
 *
 * Sent with the coordinator's real origin as `targetOrigin`, which the
 * `CHALLENGE` is what told us. `helloId` is the child's own per-attempt id,
 * echoed back in `WELCOME` so a stale or forged welcome from a racing responder
 * is dropped rather than silently re-keying the frame.
 */
const joinSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("JOIN"),
  token: idSchema,
  helloId: idSchema,
  /** HMAC of the one-shot token and hello id with manager-private storage. */
  proof: idSchema,
});

/** Top → child, over the port. Carries everything a frame needs to boot. */
const welcomeSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("WELCOME"),
  nonce: idSchema,
  frameId: idSchema,
  /** Echoes the `JOIN` that earned it; anything else is a race or a spoof. */
  helloId: idSchema,
  frames: Schema.Array(idSchema),
  exclusion: effectiveExclusionSchema,
});

/** Top → child, whenever the registry changes. Keeps `knownFrames()` honest. */
const rosterSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("ROSTER"),
  nonce: idSchema,
  frames: Schema.Array(idSchema),
});

/**
 * Top → child, after a settings change in the top frame.
 *
 * Carries the exclusion decision and nothing else. Settings used to ride along
 * here, which made the protocol a channel for pushing a CSS string, a search
 * template and a key-mapping source into every frame on the page — and made
 * `WELCOME` an exfiltration route for the user's exclusion patterns, mappings
 * and engine list. Every frame reads its own storage; this message is a
 * *prompt* to do that, not a source of truth.
 */
const settingsPushSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("SETTINGS"),
  nonce: idSchema,
  exclusion: effectiveExclusionSchema,
});

/** Origin frame → top: "run a cross-frame hint round for me". */
const requestHintsSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("REQUEST_HINTS"),
  nonce: idSchema,
  requestId: idSchema,
  mode: hintModeSchema,
});

/** Top → every frame. */
const collectHintsSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("COLLECT_HINTS"),
  nonce: idSchema,
  requestId: idSchema,
  mode: hintModeSchema,
});

/** Frame → top, answering `COLLECT_HINTS`. */
const hintsSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("HINTS"),
  nonce: idSchema,
  requestId: idSchema,
  descriptors: descriptorsSchema,
});

/**
 * Top → origin frame, answering `REQUEST_HINTS`.
 *
 * The origin's own descriptors are stripped from this payload: it already has
 * the heavyweight local hints and re-derives its own descriptors from them.
 * Upstream measured that strip as a 150% speedup on link-dense pages.
 */
const hintsResultSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("HINTS_RESULT"),
  nonce: idSchema,
  requestId: idSchema,
  descriptors: descriptorsSchema,
});

/**
 * Top → every frame *except* the origin: "a hint session is live, here is the
 * globally ordered set". Each recipient renders markers for its own hints only.
 */
const activateSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("ACTIVATE"),
  nonce: idSchema,
  originFrameId: idSchema,
  mode: hintModeSchema,
  descriptors: descriptorsSchema,
});

/** Origin → top → the owning frame: "act on one of *your* hints". */
const activateHintSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("ACTIVATE_HINT"),
  nonce: idSchema,
  targetFrameId: idSchema,
  localIndex: localIndexSchema,
  mode: hintModeSchema,
});

/**
 * Origin → top → every other frame.
 *
 * Relayed rather than acted on centrally because only the frame that owns the
 * element has a live hint marker to filter.
 */
const keystrokeSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("KEYSTROKE"),
  nonce: idSchema,
  originFrameId: idSchema,
  notation: Schema.String.check(Schema.isMaxLength(MAX_NOTATION_LENGTH)),
});

/** Any frame → top: `gf` / `gF`. */
const focusFrameSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("FOCUS_FRAME"),
  nonce: idSchema,
  direction: Schema.Literals([1, -1]),
});

/** Top → the elected frame. */
const takeFocusSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("TAKE_FOCUS"),
  nonce: idSchema,
});

/** Frame → top, when its window actually gains focus. Keeps the `gf` cursor honest. */
const focusedSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("FOCUSED"),
  nonce: idSchema,
});

/** Child → top. Answered from the *top frame's* URL; see `effectiveExclusionSchema`. */
const exclusionRequestSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("EXCLUSION_REQUEST"),
  nonce: idSchema,
  requestId: idSchema,
});

const exclusionResultSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("EXCLUSION_RESULT"),
  nonce: idSchema,
  requestId: idSchema,
  exclusion: effectiveExclusionSchema,
});

/**
 * Child → top on `pagehide` or `dispose`.
 *
 * Best-effort only. A frame yanked out of the DOM sends nothing, and posting to
 * a dead `MessagePort` does not throw, so the registry cannot rely on this —
 * see the frames-tree sweep in registry.ts.
 */
const goodbyeSchema = Schema.Struct({
  ...envelopeShape(),
  kind: Schema.Literal("GOODBYE"),
  nonce: idSchema,
});

/**
 * A union, not a discriminated union — Effect v4 has no `discriminatedUnion`.
 *
 * `Schema.Union` does index its members by their literal ("sentinel") fields,
 * but the index is a union across *every* such field, and `magic` and `v` are
 * literals that all nineteen members share. So every member stays a candidate
 * and the members are tried in order, where Zod jumped straight to the one
 * `kind` named.
 *
 * That costs about 0.5 µs per member skipped, and it does not weaken the bound
 * this file cares about, because the envelope fields are spread in first: a
 * member whose `kind` does not match is abandoned at that literal, before it
 * reads `descriptors`. Measured on the 5000-descriptor ceiling, a `HINTS`
 * payload is read exactly once and costs 2.7 ms against Zod's 2.6 ms. Hostile
 * traffic never arrives here at all; `preauthorize` drops it first.
 */
export const frameMessageSchema = Schema.Union([
  helloSchema,
  challengeSchema,
  joinSchema,
  welcomeSchema,
  rosterSchema,
  settingsPushSchema,
  requestHintsSchema,
  collectHintsSchema,
  hintsSchema,
  hintsResultSchema,
  activateSchema,
  activateHintSchema,
  keystrokeSchema,
  focusFrameSchema,
  takeFocusSchema,
  focusedSchema,
  exclusionRequestSchema,
  exclusionResultSchema,
  goodbyeSchema,
]);

export type FrameMessage = typeof frameMessageSchema.Type;
export type FrameMessageKind = FrameMessage["kind"];

/** `MessageOf<"WELCOME">` beats writing `Extract<...>` at fifteen call sites. */
export type MessageOf<K extends FrameMessageKind> = Extract<
  FrameMessage,
  { kind: K }
>;

/** Messages a frame may send to the coordinator. */
export const FRAME_TO_TOP_KINDS: ReadonlySet<FrameMessageKind> = new Set(
  [
    "HELLO",
    "JOIN",
    "REQUEST_HINTS",
    "HINTS",
    "ACTIVATE_HINT",
    "KEYSTROKE",
    "FOCUS_FRAME",
    "FOCUSED",
    "EXCLUSION_REQUEST",
    "GOODBYE",
  ] satisfies readonly FrameMessageKind[],
);

/**
 * The two kinds that travel over `window.postMessage` rather than a port.
 *
 * Everything else is port-only, so a `window`-level listener that sees one is
 * looking at page traffic and should drop it without further thought.
 */
export const WINDOW_TO_TOP_KINDS: ReadonlySet<FrameMessageKind> = new Set(
  ["HELLO", "JOIN"] satisfies readonly FrameMessageKind[],
);

/** Top → child over `window.postMessage`; the only one. */
export const TOP_TO_WINDOW_KINDS: ReadonlySet<FrameMessageKind> = new Set(
  ["CHALLENGE"] satisfies readonly FrameMessageKind[],
);

/** Messages the coordinator may send to a frame. */
export const TOP_TO_FRAME_KINDS: ReadonlySet<FrameMessageKind> = new Set(
  [
    "WELCOME",
    "ROSTER",
    "SETTINGS",
    "COLLECT_HINTS",
    "HINTS_RESULT",
    "ACTIVATE",
    "ACTIVATE_HINT",
    "KEYSTROKE",
    "TAKE_FOCUS",
    "EXCLUSION_RESULT",
  ] satisfies readonly FrameMessageKind[],
);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Built once, at module load, and reused for every message.
 *
 * `Schema.decodeUnknownOption` rather than `decodeUnknownResult` from
 * `~/platform/schema-io.ts`: both are synchronous and neither throws, but this
 * boundary discards the diagnosis anyway (see `parseFrameMessage`), and the
 * `Option` form takes `unknown` directly and never formats an error message a
 * hostile page would be paying us to produce.
 */
const decodeFrameMessage = Schema.decodeUnknownOption(frameMessageSchema);

/**
 * The single entry point for untrusted data.
 *
 * Returns `null` rather than throwing or returning a `Result`: at this boundary
 * every failure has exactly one response — drop the message silently — and a
 * hostile page would otherwise get to choose how much work we do reporting it.
 */
export const parseFrameMessage = (data: unknown): FrameMessage | null => {
  // The magic check is not a security control, it is a cost control: busy pages
  // postMessage constantly and a full decode of every one of them is waste.
  if (
    typeof data !== "object" || data === null ||
    (data as { magic?: unknown }).magic !== PROTOCOL_MAGIC
  ) {
    return null;
  }
  const decoded = decodeFrameMessage(data);
  return Option.isSome(decoded) ? decoded.value : null;
};

/**
 * The handshake kinds, which by definition precede nonce knowledge.
 *
 * Their trust comes from the transport instead: `HELLO` grants nothing at all,
 * `CHALLENGE` is only honoured from a strict ancestor, `JOIN` must quote a
 * token the coordinator issued to that exact window, and `WELCOME` must quote
 * the `helloId` of the attempt still in flight.
 */
const NONCELESS_KINDS: ReadonlySet<FrameMessageKind> = new Set(
  [
    "HELLO",
    "CHALLENGE",
    "JOIN",
    "WELCOME",
  ] satisfies readonly FrameMessageKind[],
);

export interface InboundOptions {
  readonly expectedNonce: string | null;
  readonly allowedKinds: ReadonlySet<FrameMessageKind>;
}

/**
 * Decide whether a payload is worth validating, by direct property read.
 *
 * This runs *before* `frameMessageSchema` is decoded, and that ordering is the
 * point: a descriptor array is bounded but still large, and validating one for
 * a sender we were always going to reject hands an attacker our main thread for
 * free. Reads four properties and compares four values.
 */
export const preauthorize = (
  data: unknown,
  options: InboundOptions,
): boolean => {
  if (typeof data !== "object" || data === null) return false;
  const raw = data as Record<string, unknown>;
  if (raw["magic"] !== PROTOCOL_MAGIC || raw["v"] !== PROTOCOL_VERSION) {
    return false;
  }

  const kind = raw["kind"];
  if (typeof kind !== "string") return false;
  const known = kind as FrameMessageKind;
  if (!options.allowedKinds.has(known)) return false;
  if (NONCELESS_KINDS.has(known)) return true;

  // Not constant-time. It does not need to be: the attacker is same-page and
  // can already observe our timing far more directly than through this compare.
  return options.expectedNonce !== null &&
    raw["nonce"] === options.expectedNonce;
};

/**
 * Parse and check both the direction and the session nonce.
 *
 * `expectedNonce` is `null` until this side has been welcomed, at which point
 * only the handshake kinds are legal — anything else is either a race we should
 * ignore or a spoof.
 */
export const parseInbound = (
  data: unknown,
  options: InboundOptions,
): FrameMessage | null => {
  if (!preauthorize(data, options)) return null;
  const message = parseFrameMessage(data);
  if (message === null) return null;
  // Re-checked against the *parsed* message: `preauthorize` trusts a raw
  // property read, and the two must not be able to disagree.
  if (!options.allowedKinds.has(message.kind)) return null;
  if (NONCELESS_KINDS.has(message.kind)) return message;
  return "nonce" in message && message.nonce === options.expectedNonce
    ? message
    : null;
};

/**
 * A per-session nonce, distributed top-down in `WELCOME`.
 *
 * 128 bits from the CSPRNG. `crypto.getRandomValues` is available in every
 * target (Safari 11+) and in Node, so there is no fallback path to get wrong.
 * Also used for the one-shot admission tokens and for per-attempt `helloId`s,
 * where the same properties are wanted for the same reason.
 */
export const createNonce = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};

/** Monotonic per-frame request ids; correlation is scoped to a single port. */
export const createRequestIdFactory = (
  prefix: string,
): () => string => {
  let next = 0;
  return () => `${prefix}:${(next++).toString(36)}`;
};
