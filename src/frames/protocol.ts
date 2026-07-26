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
 * inbound payload is `safeParse`d and dropped on failure — there is no
 * "probably fine" path. Keep this module free of DOM access so it stays
 * unit-testable under `deno test`.
 *
 * ## Security posture — accept and document, do not gold-plate
 *
 * A malicious page can post messages that look like our protocol. The
 * mitigations are:
 *
 * 1. `event.source` is validated against the real frames tree (registry.ts),
 * 2. every payload is Zod-validated here and dropped on failure, and
 * 3. a per-session nonce is distributed top-down in `WELCOME` and echoed on
 *    every subsequent message.
 *
 * None of this is airtight in page world, where the page shares our realm; in
 * content world the page cannot read the nonce. The worst realistic case is
 * spoofed hint descriptors pointing at page-controlled elements — which the
 * page could click itself anyway. **Severity: low. Do not over-engineer this.**
 */

import * as z from "zod/mini";
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
export const PROTOCOL_VERSION = 1;

/** Vimium's number, and for Vimium's reason: a hung frame must not deadlock a mode. */
export const REQUEST_DEADLINE_MS = 3000;

/** Envelope literals, spread into every outbound message. */
export const ENVELOPE = {
  magic: PROTOCOL_MAGIC,
  v: PROTOCOL_VERSION,
} as const;

const envelopeShape = () => ({
  magic: z.literal(PROTOCOL_MAGIC),
  v: z.literal(PROTOCOL_VERSION),
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Ceilings, not tuning knobs. They exist so that a hostile or broken frame
 * cannot make us allocate without limit before we have decided to trust it.
 */
const MAX_ID_LENGTH = 64;
const MAX_LINK_TEXT = 1024;
const MAX_LOCAL_INDEX = 100_000;
const MAX_DESCRIPTORS = 20_000;
const MAX_NOTATION_LENGTH = 64;

const idSchema = z.string().check(z.maxLength(MAX_ID_LENGTH));

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

export const hintModeSchema = z.enum(HINT_MODES);

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

export const hintDescriptorSchema = z.object({
  frameId: idSchema,
  localIndex: z.int().check(z.minimum(0), z.maximum(MAX_LOCAL_INDEX)),
  linkText: z.string().check(z.maxLength(MAX_LINK_TEXT)),
  secondary: z.boolean(),
});

const descriptorsSchema = z.readonly(
  z.array(hintDescriptorSchema).check(z.maxLength(MAX_DESCRIPTORS)),
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
export const effectiveExclusionSchema = z.object({
  enabled: z.boolean(),
  passKeys: z.string().check(z.maxLength(1024)),
});

export type EffectiveExclusion = z.infer<typeof effectiveExclusionSchema>;

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
 * Child → top, over `window.top.postMessage` with `port2` transferred.
 *
 * The only message that travels over `window.postMessage`, and the only one
 * without a nonce — the child cannot know the nonce until it is welcomed. That
 * asymmetry is the documented soft spot in the threat model above.
 */
const helloSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("HELLO"),
});

/** Top → child, over the port. Carries everything a frame needs to boot. */
const welcomeSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("WELCOME"),
  nonce: idSchema,
  frameId: idSchema,
  frames: z.readonly(z.array(idSchema)),
  /**
   * Deliberately unvalidated here: validating against `settingsSchema` would
   * make a version-skewed frame drop the whole `WELCOME` and never boot. The
   * consumer re-validates (`onSettingsPushed`).
   */
  settings: z.unknown(),
  exclusion: effectiveExclusionSchema,
});

/** Top → child, whenever the registry changes. Keeps `knownFrames()` honest. */
const rosterSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("ROSTER"),
  nonce: idSchema,
  frames: z.readonly(z.array(idSchema)),
});

/** Top → child, after `AppContext.refresh()` in the top frame. */
const settingsPushSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("SETTINGS"),
  nonce: idSchema,
  settings: z.unknown(),
  exclusion: effectiveExclusionSchema,
});

/** Origin frame → top: "run a cross-frame hint round for me". */
const requestHintsSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("REQUEST_HINTS"),
  nonce: idSchema,
  requestId: idSchema,
  mode: hintModeSchema,
});

/** Top → every frame. */
const collectHintsSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("COLLECT_HINTS"),
  nonce: idSchema,
  requestId: idSchema,
  mode: hintModeSchema,
});

/** Frame → top, answering `COLLECT_HINTS`. */
const hintsSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("HINTS"),
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
const hintsResultSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("HINTS_RESULT"),
  nonce: idSchema,
  requestId: idSchema,
  descriptors: descriptorsSchema,
});

/**
 * Top → every frame *except* the origin: "a hint session is live, here is the
 * globally ordered set". Each recipient renders markers for its own hints only.
 */
const activateSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("ACTIVATE"),
  nonce: idSchema,
  originFrameId: idSchema,
  mode: hintModeSchema,
  descriptors: descriptorsSchema,
});

/** Origin → top → the owning frame: "act on one of *your* hints". */
const activateHintSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("ACTIVATE_HINT"),
  nonce: idSchema,
  targetFrameId: idSchema,
  localIndex: z.int().check(z.minimum(0), z.maximum(MAX_LOCAL_INDEX)),
  mode: hintModeSchema,
});

/**
 * Origin → top → every other frame.
 *
 * Relayed rather than acted on centrally because only the frame that owns the
 * element has a live hint marker to filter.
 */
const keystrokeSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("KEYSTROKE"),
  nonce: idSchema,
  originFrameId: idSchema,
  notation: z.string().check(z.maxLength(MAX_NOTATION_LENGTH)),
});

/** Any frame → top: `gf` / `gF`. */
const focusFrameSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("FOCUS_FRAME"),
  nonce: idSchema,
  direction: z.union([z.literal(1), z.literal(-1)]),
});

/** Top → the elected frame. */
const takeFocusSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("TAKE_FOCUS"),
  nonce: idSchema,
});

/** Frame → top, when its window actually gains focus. Keeps the `gf` cursor honest. */
const focusedSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("FOCUSED"),
  nonce: idSchema,
});

/** Child → top. Answered from the *top frame's* URL; see `effectiveExclusionSchema`. */
const exclusionRequestSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("EXCLUSION_REQUEST"),
  nonce: idSchema,
  requestId: idSchema,
});

const exclusionResultSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("EXCLUSION_RESULT"),
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
const goodbyeSchema = z.object({
  ...envelopeShape(),
  kind: z.literal("GOODBYE"),
  nonce: idSchema,
});

export const frameMessageSchema = z.discriminatedUnion("kind", [
  helloSchema,
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

export type FrameMessage = z.infer<typeof frameMessageSchema>;
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
 * The single entry point for untrusted data.
 *
 * Returns `null` rather than throwing or returning a `Result`: at this boundary
 * every failure has exactly one response — drop the message silently — and a
 * hostile page would otherwise get to choose how much work we do reporting it.
 */
export const parseFrameMessage = (data: unknown): FrameMessage | null => {
  // The magic check is not a security control, it is a cost control: busy pages
  // postMessage constantly and full `safeParse` on every one of them is waste.
  if (
    typeof data !== "object" || data === null ||
    (data as { magic?: unknown }).magic !== PROTOCOL_MAGIC
  ) {
    return null;
  }
  const result = frameMessageSchema.safeParse(data);
  return result.success ? result.data : null;
};

/**
 * The two handshake messages, which by definition precede nonce knowledge.
 *
 * Their trust comes from the transport instead: `HELLO` is admitted only after
 * its `event.source` is found in the frames tree, and `WELCOME` can only arrive
 * on a port whose other end was transferred to `window.top` alone.
 */
const NONCELESS_KINDS: ReadonlySet<FrameMessageKind> = new Set(
  ["HELLO", "WELCOME"] satisfies readonly FrameMessageKind[],
);

/**
 * Parse and check both the direction and the session nonce.
 *
 * `expectedNonce` is `null` until this side has been welcomed, at which point
 * only the handshake kinds are legal — anything else is either a race we should
 * ignore or a spoof.
 */
export const parseInbound = (
  data: unknown,
  options: {
    readonly expectedNonce: string | null;
    readonly allowedKinds: ReadonlySet<FrameMessageKind>;
  },
): FrameMessage | null => {
  const message = parseFrameMessage(data);
  if (message === null) return null;
  if (!options.allowedKinds.has(message.kind)) return null;
  if (NONCELESS_KINDS.has(message.kind)) return message;
  if (options.expectedNonce === null) return null;
  // Not constant-time. It does not need to be: the attacker is same-page and
  // can already observe our timing far more directly than through this compare.
  return "nonce" in message && message.nonce === options.expectedNonce
    ? message
    : null;
};

/**
 * A per-session nonce, distributed top-down in `WELCOME`.
 *
 * 128 bits from the CSPRNG. `crypto.getRandomValues` is available in every
 * target (Safari 11+) and in Deno, so there is no fallback path to get wrong.
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
