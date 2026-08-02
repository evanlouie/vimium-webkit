/**
 * Cross-frame protocol: schema validation and ordering.
 *
 * Two properties are load-bearing and neither is visible by inspection.
 *
 * **Validation.** Every inbound message comes from a frame we do not control,
 * over a channel a hostile page can also post to. A parser that lets one
 * malformed field through does not crash — it corrupts a hint session in a way
 * that looks like a rendering bug three files away.
 *
 * **Ordering.** Every frame sorts the merged descriptor set independently and
 * derives its hint strings from the result. A comparator that disagrees by one
 * position means two frames disagree about what `sa` means, and the user
 * activates the wrong link. The order must therefore be total, deterministic,
 * and independent of the order replies happen to arrive in.
 */

import { test } from "vitest";
import type {
  FrameLinkApi,
  HintMode,
  RemoteHintDescriptor,
} from "~/core/context.ts";
import type { LocalHintsApi } from "~/features/hints/index.ts";
import { FrameCoordinator } from "~/frames/coordinator.ts";
import {
  createFrameLink,
  type FrameLink,
  type LocalHintsBridge,
} from "~/frames/index.ts";
import {
  compareDescriptors,
  createNonce,
  createRequestIdFactory,
  DEFAULT_EXCLUSION,
  ENVELOPE,
  formatFrameId,
  type FrameMessage,
  HINT_MODE_COVERAGE,
  parseFrameMessage,
  parseInbound,
  PROTOCOL_MAGIC,
  PROTOCOL_VERSION,
  sortDescriptors,
  TOP_TO_FRAME_KINDS,
} from "~/frames/protocol.ts";
import { loopbackChannel } from "~/frames/registry.ts";
import { assert, assertEquals } from "./support/assert.ts";

// ---------------------------------------------------------------------------
// Type-level contracts
//
// These never run. They fail the build instead, which is the point: both
// assignments are relied upon by files this module is forbidden to edit.
//
// Exported only so `noUnusedLocals` does not delete the assertion as dead. The
// binding is the assertion: assigning `true` to `never` is what fails.
// ---------------------------------------------------------------------------

type _HintsApiSatisfiesBridge = LocalHintsApi extends LocalHintsBridge ? true
  : never;
type _FrameLinkSatisfiesApi = FrameLink extends FrameLinkApi ? true : never;
export const _contracts: [_HintsApiSatisfiesBridge, _FrameLinkSatisfiesApi] = [
  true,
  true,
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const descriptor = (
  frameId: string,
  localIndex: number,
  overrides: Partial<RemoteHintDescriptor> = {},
): RemoteHintDescriptor => ({
  frameId,
  localIndex,
  linkText: `${frameId}#${localIndex}`,
  secondary: false,
  ...overrides,
});

const hello = (): unknown => ({ ...ENVELOPE, kind: "HELLO" });

const welcome = (nonce: string, helloId = ""): unknown => ({
  ...ENVELOPE,
  kind: "WELCOME",
  nonce,
  frameId: "f0000",
  helloId,
  frames: ["f0000"],
  exclusion: { enabled: true, passKeys: "" },
});

/**
 * Let every queued microtask and timer-zero continuation settle.
 *
 * Recursive rather than a loop: the turns are inherently sequential, and
 * `no-await-in-loop` is right that a loop here usually means a missed
 * `Promise.all`.
 */
const flush = (turns = 3): Promise<void> =>
  turns <= 0 ? Promise.resolve() : new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  }).then(() => flush(turns - 1));

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

test("parseFrameMessage rejects anything that is not our envelope", () => {
  for (
    const data of [
      undefined,
      null,
      42,
      "HELLO",
      [],
      {},
      { kind: "HELLO" },
      { magic: "other", v: PROTOCOL_VERSION, kind: "HELLO" },
    ]
  ) {
    assertEquals(parseFrameMessage(data), null, `accepted ${String(data)}`);
  }
});

test("parseFrameMessage rejects a foreign protocol version", () => {
  // Two script versions genuinely coexist when a manager updates between the
  // top frame's load and a lazily-inserted iframe's.
  assertEquals(
    parseFrameMessage({
      magic: PROTOCOL_MAGIC,
      v: PROTOCOL_VERSION + 1,
      kind: "HELLO",
    }),
    null,
  );
});

test("parseFrameMessage rejects an unknown kind", () => {
  assertEquals(parseFrameMessage({ ...ENVELOPE, kind: "EVAL" }), null);
});

test("parseFrameMessage strips unknown keys", () => {
  const parsed = parseFrameMessage({ ...ENVELOPE, kind: "HELLO", evil: "x" });
  assertEquals(parsed, { ...ENVELOPE, kind: "HELLO" });
  assert(parsed !== null && !("evil" in parsed));
});

test("parseFrameMessage requires every field of a kind", () => {
  const nonce = createNonce();
  assertEquals(
    parseFrameMessage({ ...ENVELOPE, kind: "KEYSTROKE", nonce }),
    null,
    "missing notation",
  );
  assertEquals(
    parseFrameMessage({
      ...ENVELOPE,
      kind: "KEYSTROKE",
      originFrameId: "f0001",
      notation: "a",
    }),
    null,
    "missing nonce",
  );
  assert(
    parseFrameMessage({
      ...ENVELOPE,
      kind: "KEYSTROKE",
      nonce,
      originFrameId: "f0001",
      notation: "a",
    }) !== null,
  );
});

test("parseFrameMessage bounds hostile payloads", () => {
  const nonce = createNonce();
  const message = (descriptors: readonly unknown[]): unknown => ({
    ...ENVELOPE,
    kind: "HINTS",
    nonce,
    requestId: "r:0",
    descriptors,
  });

  assertEquals(
    parseFrameMessage(message([{ ...descriptor("f1", -1) }])),
    null,
    "negative localIndex",
  );
  assertEquals(
    parseFrameMessage(message([{ ...descriptor("f1", 1.5) }])),
    null,
    "fractional localIndex",
  );
  assertEquals(
    parseFrameMessage(
      message([{ frameId: "f1", localIndex: 0, linkText: "x" }]),
    ),
    null,
    "missing secondary",
  );
  assertEquals(
    parseFrameMessage(message([{ ...descriptor("f".repeat(65), 0) }])),
    null,
    "oversized frameId",
  );
  assertEquals(
    parseFrameMessage(
      message(
        Array.from({ length: 5_001 }, (_, i) => descriptor("f0001", i)),
      ),
    ),
    null,
    "unbounded descriptor array",
  );
  assert(parseFrameMessage(message([descriptor("f0001", 0)])) !== null);
});

test("parseFrameMessage accepts a message of every kind", () => {
  const nonce = createNonce();
  const samples: readonly unknown[] = [
    hello(),
    { ...ENVELOPE, kind: "CHALLENGE", token: "t0" },
    { ...ENVELOPE, kind: "JOIN", token: "t0", helloId: "h0" },
    welcome(nonce),
    { ...ENVELOPE, kind: "ROSTER", nonce, frames: ["f0000", "f0001"] },
    {
      ...ENVELOPE,
      kind: "SETTINGS",
      nonce,
      exclusion: DEFAULT_EXCLUSION,
    },
    {
      ...ENVELOPE,
      kind: "REQUEST_HINTS",
      nonce,
      requestId: "r:0",
      mode: "activate",
    },
    {
      ...ENVELOPE,
      kind: "COLLECT_HINTS",
      nonce,
      requestId: "r:0",
      mode: "hover",
    },
    { ...ENVELOPE, kind: "HINTS", nonce, requestId: "r:0", descriptors: [] },
    {
      ...ENVELOPE,
      kind: "HINTS_RESULT",
      nonce,
      requestId: "r:0",
      descriptors: [descriptor("f0001", 0)],
    },
    {
      ...ENVELOPE,
      kind: "ACTIVATE",
      nonce,
      originFrameId: "f0000",
      mode: "focus",
      descriptors: [],
    },
    {
      ...ENVELOPE,
      kind: "ACTIVATE_HINT",
      nonce,
      targetFrameId: "f0001",
      localIndex: 4,
      mode: "download",
    },
    {
      ...ENVELOPE,
      kind: "KEYSTROKE",
      nonce,
      originFrameId: "f0000",
      notation: "<c-a>",
    },
    { ...ENVELOPE, kind: "FOCUS_FRAME", nonce, direction: -1 },
    { ...ENVELOPE, kind: "TAKE_FOCUS", nonce },
    { ...ENVELOPE, kind: "FOCUSED", nonce },
    { ...ENVELOPE, kind: "EXCLUSION_REQUEST", nonce, requestId: "r:1" },
    {
      ...ENVELOPE,
      kind: "EXCLUSION_RESULT",
      nonce,
      requestId: "r:1",
      exclusion: { enabled: false, passKeys: "gj" },
    },
    { ...ENVELOPE, kind: "GOODBYE", nonce },
  ];

  for (const sample of samples) {
    assert(
      parseFrameMessage(sample) !== null,
      `rejected ${JSON.stringify(sample)}`,
    );
  }
});

test("every HintMode survives the wire", () => {
  assertEquals(HINT_MODE_COVERAGE, true);
  const modes: readonly HintMode[] = [
    "activate",
    "activate-new-tab",
    "activate-new-tab-background",
    "hover",
    "focus",
    "copy-link-url",
    "copy-link-text",
    "open-with-omnibar",
    "download",
  ];
  const nonce = createNonce();
  for (const mode of modes) {
    const parsed = parseFrameMessage({
      ...ENVELOPE,
      kind: "COLLECT_HINTS",
      nonce,
      requestId: "r:0",
      mode,
    });
    assert(parsed !== null && parsed.kind === "COLLECT_HINTS");
    assertEquals(parsed.mode, mode);
  }
  assertEquals(
    parseFrameMessage({
      ...ENVELOPE,
      kind: "COLLECT_HINTS",
      nonce,
      requestId: "r:0",
      mode: "delete-everything",
    }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Direction and nonce
// ---------------------------------------------------------------------------

test("parseInbound enforces message direction", () => {
  const nonce = createNonce();
  const roster = { ...ENVELOPE, kind: "ROSTER", nonce, frames: [] };
  // A child must not be able to talk the coordinator into believing it *is* the
  // coordinator by echoing a top-to-frame message back up the port.
  assertEquals(
    parseInbound(roster, {
      expectedNonce: nonce,
      allowedKinds: new Set(["REQUEST_HINTS", "GOODBYE"]),
    }),
    null,
  );
  assert(
    parseInbound(roster, {
      expectedNonce: nonce,
      allowedKinds: TOP_TO_FRAME_KINDS,
    }) !== null,
  );
});

test("parseInbound drops a wrong or absent nonce", () => {
  const nonce = createNonce();
  const goodbye = (value: string): unknown => ({
    ...ENVELOPE,
    kind: "GOODBYE",
    nonce: value,
  });
  const allowedKinds = new Set<FrameMessage["kind"]>(["GOODBYE"]);

  assert(parseInbound(goodbye(nonce), { expectedNonce: nonce, allowedKinds }));
  assertEquals(
    parseInbound(goodbye(createNonce()), {
      expectedNonce: nonce,
      allowedKinds,
    }),
    null,
  );
  assertEquals(
    parseInbound(goodbye(nonce), { expectedNonce: null, allowedKinds }),
    null,
    "nothing is trusted before the handshake completes",
  );
});

test("parseInbound lets the handshake through without a nonce", () => {
  // The handshake kinds necessarily precede nonce knowledge; their trust comes
  // from the transport instead — a token bound to one window, a port
  // transferred to one origin, and a `helloId` bound to one attempt.
  assert(
    parseInbound(hello(), {
      expectedNonce: null,
      allowedKinds: new Set(["HELLO"]),
    }) !== null,
  );
  assert(
    parseInbound(welcome(createNonce()), {
      expectedNonce: null,
      allowedKinds: TOP_TO_FRAME_KINDS,
    }) !== null,
  );
});

test("createNonce is unpredictable enough and unique", () => {
  const nonces = new Set(Array.from({ length: 1000 }, createNonce));
  assertEquals(nonces.size, 1000);
  for (const nonce of nonces) assertEquals(nonce.length, 32);
});

test("request ids are unique per factory", () => {
  const next = createRequestIdFactory("top");
  const ids = Array.from({ length: 500 }, next);
  assertEquals(new Set(ids).size, ids.length);
  assert(ids.every((id) => id.startsWith("top:")));
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("frame ids sort lexicographically in numeric order", () => {
  // Descriptors are sorted by `frameId` *as a string*, so unpadded ids would
  // put frame 10 before frame 2.
  const ids = Array.from({ length: 24 }, (_, i) => formatFrameId(i));
  assertEquals(ids[0], "f0000");
  assertEquals(ids[10], "f0010");
  assertEquals([...ids].sort(), ids);
});

test("compareDescriptors orders by frame, then by local index", () => {
  assert(
    compareDescriptors(descriptor("f0000", 9), descriptor("f0001", 0)) < 0,
  );
  assert(
    compareDescriptors(descriptor("f0001", 0), descriptor("f0001", 1)) < 0,
  );
  assertEquals(
    compareDescriptors(descriptor("f0001", 3), descriptor("f0001", 3)),
    0,
  );
});

test("sortDescriptors is a total order, independent of arrival", () => {
  const canonical = [
    descriptor("f0000", 0),
    descriptor("f0000", 1),
    descriptor("f0001", 0),
    descriptor("f0002", 0),
    descriptor("f0002", 7),
    descriptor("f0010", 0),
  ];

  // Frames reply in whatever order the network and the event loop produce; the
  // derived hint strings must not depend on that.
  let seed = 1;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 50; trial++) {
    const shuffled = [...canonical];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const a = shuffled[i];
      const b = shuffled[j];
      if (a === undefined || b === undefined) continue;
      shuffled[i] = b;
      shuffled[j] = a;
    }
    assertEquals(sortDescriptors(shuffled), canonical);
  }
});

test("sortDescriptors does not mutate its input", () => {
  const input = [descriptor("f0002", 0), descriptor("f0001", 0)];
  const copy = [...input];
  sortDescriptors(input);
  assertEquals(input, copy);
});

test("sortDescriptors ignores the secondary flag", () => {
  // `secondary` re-ranks hints *within* a frame's own detection pass; letting
  // it into the cross-frame comparator would make the global order depend on
  // per-frame heuristics that other frames cannot reproduce.
  const a = descriptor("f0001", 0, { secondary: true });
  const b = descriptor("f0001", 1, { secondary: false });
  assertEquals(sortDescriptors([b, a]), [a, b]);
});

// ---------------------------------------------------------------------------
// Coordinator round trip
//
// Driven entirely over loopback channels, so it runs under Vitest with no
// DOM. `root: null` disables the frames-tree checks, which are the one part
// that genuinely needs a browser.
// ---------------------------------------------------------------------------

interface FakeFrame {
  frameId: string;
  nonce: string;
  readonly inbox: FrameMessage[];
}

/** How a fake frame answers `COLLECT_HINTS`. `"silent"` never answers at all. */
type Replier =
  | "silent"
  | ((frameId: string) => readonly RemoteHintDescriptor[]);

/** The honest reply: `n` descriptors attributed to oneself, as `collectLocal` does. */
const owns = (count: number): Replier => (frameId: string) =>
  Array.from(
    { length: count },
    (_, localIndex) => descriptor(frameId, localIndex),
  );

const attachFrame = (
  coordinator: FrameCoordinator,
  reply: Replier,
): FakeFrame => {
  const frame: FakeFrame = { frameId: "", nonce: "", inbox: [] };

  const channel = loopbackChannel((message: FrameMessage) => {
    frame.inbox.push(message);
    if (message.kind === "WELCOME") {
      frame.frameId = message.frameId;
      frame.nonce = message.nonce;
      return;
    }
    if (message.kind === "COLLECT_HINTS" && reply !== "silent") {
      coordinator.receive(frame.frameId, {
        ...ENVELOPE,
        kind: "HINTS",
        nonce: frame.nonce,
        requestId: message.requestId,
        descriptors: reply(frame.frameId),
      });
    }
  });

  frame.frameId = coordinator.admitLocal(channel);
  return frame;
};

const inboxOf = (
  frame: FakeFrame,
  kind: FrameMessage["kind"],
): readonly FrameMessage[] => frame.inbox.filter((m) => m.kind === kind);

test("a hint round merges every frame into one canonical order", async () => {
  const coordinator = new FrameCoordinator({ root: null });
  const origin = attachFrame(coordinator, owns(2));
  const second = attachFrame(coordinator, owns(3));
  const third = attachFrame(coordinator, owns(1));
  await flush();

  assertEquals(
    [origin.frameId, second.frameId, third.frameId],
    ["f0000", "f0001", "f0002"],
  );

  coordinator.receive(origin.frameId, {
    ...ENVELOPE,
    kind: "REQUEST_HINTS",
    nonce: origin.nonce,
    requestId: "req-1",
    mode: "activate",
  });
  await flush(5);

  const [result] = inboxOf(origin, "HINTS_RESULT");
  assert(result !== undefined && result.kind === "HINTS_RESULT");
  assertEquals(result.requestId, "req-1");
  // The origin's own descriptors are stripped: it re-derives them from the
  // local hints it already holds (upstream's 150% speedup).
  assertEquals(
    result.descriptors.map((d) => `${d.frameId}:${d.localIndex}`),
    ["f0001:0", "f0001:1", "f0001:2", "f0002:0"],
  );

  // Every other frame gets the same global set minus its own entries, so that
  // re-inserting its own hints reproduces the origin's ordering exactly.
  const [activateSecond] = inboxOf(second, "ACTIVATE");
  assert(activateSecond !== undefined && activateSecond.kind === "ACTIVATE");
  assertEquals(activateSecond.originFrameId, origin.frameId);
  assertEquals(activateSecond.mode, "activate");
  assertEquals(
    activateSecond.descriptors.map((d) => `${d.frameId}:${d.localIndex}`),
    ["f0000:0", "f0000:1", "f0002:0"],
  );

  const [activateThird] = inboxOf(third, "ACTIVATE");
  assert(activateThird !== undefined && activateThird.kind === "ACTIVATE");
  assertEquals(
    activateThird.descriptors.map((d) => `${d.frameId}:${d.localIndex}`),
    ["f0000:0", "f0000:1", "f0001:0", "f0001:1", "f0001:2"],
  );

  // The origin never receives an ACTIVATE; HINTS_RESULT is its copy.
  assertEquals(inboxOf(origin, "ACTIVATE").length, 0);
  coordinator.dispose();
});

test("a frame may only speak for itself", async () => {
  const coordinator = new FrameCoordinator({ root: null });
  const origin = attachFrame(coordinator, owns(0));
  // Descriptors attributed to another frame are dropped. Not because the attack
  // is dangerous — see the security note in protocol.ts — but because
  // misattribution corrupts the ordering every frame depends on.
  const liar = attachFrame(
    coordinator,
    (frameId) => [descriptor("f0000", 99), descriptor(frameId, 0)],
  );
  await flush();

  coordinator.receive(origin.frameId, {
    ...ENVELOPE,
    kind: "REQUEST_HINTS",
    nonce: origin.nonce,
    requestId: "req-1",
    mode: "activate",
  });
  await flush(5);

  const [result] = inboxOf(origin, "HINTS_RESULT");
  assert(result !== undefined && result.kind === "HINTS_RESULT");
  assertEquals(
    result.descriptors.map((d) => `${d.frameId}:${d.localIndex}`),
    [`${liar.frameId}:0`],
  );
  coordinator.dispose();
});

test("a stale nonce buys a frame nothing", async () => {
  const coordinator = new FrameCoordinator({ root: null });
  const origin = attachFrame(coordinator, owns(0));
  await flush();

  coordinator.receive(origin.frameId, {
    ...ENVELOPE,
    kind: "REQUEST_HINTS",
    nonce: createNonce(),
    requestId: "req-1",
    mode: "activate",
  });
  await flush();
  assertEquals(inboxOf(origin, "COLLECT_HINTS").length, 0);
  coordinator.dispose();
});

test("keystrokes reach every frame but the one they happened in", async () => {
  const coordinator = new FrameCoordinator({ root: null });
  const origin = attachFrame(coordinator, owns(0));
  const other = attachFrame(coordinator, owns(0));
  await flush();

  // A keystroke only means anything inside a round, so start one.
  coordinator.receive(origin.frameId, {
    ...ENVELOPE,
    kind: "REQUEST_HINTS",
    nonce: origin.nonce,
    requestId: "r:keys",
    mode: "activate",
  });
  await flush();

  coordinator.receive(origin.frameId, {
    ...ENVELOPE,
    kind: "KEYSTROKE",
    nonce: origin.nonce,
    // The claimed origin is ignored in favour of the connection's identity.
    originFrameId: "f9999",
    notation: "s",
  });
  await flush();

  assertEquals(inboxOf(origin, "KEYSTROKE").length, 0);
  const [relayed] = inboxOf(other, "KEYSTROKE");
  assert(relayed !== undefined && relayed.kind === "KEYSTROKE");
  assertEquals(relayed.originFrameId, origin.frameId);
  assertEquals(relayed.notation, "s");
  coordinator.dispose();
});

test("a frame that did not start the round cannot drive it", async () => {
  // The exact escalation this closes: `ACTIVATE_HINT` ends in a programmatic
  // click, hover, focus or clipboard write inside a document of a *different
  // origin*, and it used to be relayed to whatever frame the sender named, with
  // no check that the sender had started a round or that a round existed.
  const coordinator = new FrameCoordinator({ root: null });
  const origin = attachFrame(coordinator, owns(1));
  const bystander = attachFrame(coordinator, owns(1));
  const victim = attachFrame(coordinator, owns(1));
  await flush();

  const activate = (from: FakeFrame, mode: HintMode): void => {
    coordinator.receive(from.frameId, {
      ...ENVELOPE,
      kind: "ACTIVATE_HINT",
      nonce: from.nonce,
      targetFrameId: victim.frameId,
      localIndex: 0,
      mode,
    });
  };

  // No round at all.
  activate(bystander, "activate");
  await flush();
  assertEquals(inboxOf(victim, "ACTIVATE_HINT").length, 0, "no live round");

  coordinator.receive(origin.frameId, {
    ...ENVELOPE,
    kind: "REQUEST_HINTS",
    nonce: origin.nonce,
    requestId: "r:round",
    mode: "activate",
  });
  await flush();

  activate(bystander, "activate");
  await flush();
  assertEquals(
    inboxOf(victim, "ACTIVATE_HINT").length,
    0,
    "a frame that is not the origin",
  );

  // A mode the round was not opened in is a different capability: `activate`
  // clicks, `copy-link-url` writes the clipboard.
  activate(origin, "copy-link-url");
  await flush();
  assertEquals(inboxOf(victim, "ACTIVATE_HINT").length, 0, "a different mode");

  activate(origin, "activate");
  await flush();
  assertEquals(inboxOf(victim, "ACTIVATE_HINT").length, 1, "the origin may");

  // One activation ends the round; a second is a fresh capability request.
  activate(origin, "activate");
  await flush();
  assertEquals(inboxOf(victim, "ACTIVATE_HINT").length, 1, "and only once");

  coordinator.dispose();
});

test("a keystroke from a frame that is not the round's origin is dropped", async () => {
  const coordinator = new FrameCoordinator({ root: null });
  const origin = attachFrame(coordinator, owns(0));
  const bystander = attachFrame(coordinator, owns(0));
  const other = attachFrame(coordinator, owns(0));
  await flush();

  coordinator.receive(origin.frameId, {
    ...ENVELOPE,
    kind: "REQUEST_HINTS",
    nonce: origin.nonce,
    requestId: "r:round",
    mode: "activate",
  });
  await flush();

  coordinator.receive(bystander.frameId, {
    ...ENVELOPE,
    kind: "KEYSTROKE",
    nonce: bystander.nonce,
    originFrameId: bystander.frameId,
    notation: "s",
  });
  await flush();

  assertEquals(inboxOf(other, "KEYSTROKE").length, 0);
  coordinator.dispose();
});

test("gf walks the roster and wraps in both directions", async () => {
  const coordinator = new FrameCoordinator({ root: null });
  const first = attachFrame(coordinator, owns(0));
  const second = attachFrame(coordinator, owns(0));
  const third = attachFrame(coordinator, owns(0));
  await flush();

  coordinator.focusFrame(1);
  coordinator.focusFrame(1);
  coordinator.focusFrame(1);
  await flush();
  assertEquals(inboxOf(second, "TAKE_FOCUS").length, 1);
  assertEquals(inboxOf(third, "TAKE_FOCUS").length, 1);
  assertEquals(inboxOf(first, "TAKE_FOCUS").length, 1, "wraps to the start");

  coordinator.focusFrame(-1);
  await flush();
  assertEquals(inboxOf(third, "TAKE_FOCUS").length, 2, "wraps backwards");
  coordinator.dispose();
});

test("the exclusion answer always comes from the top frame's URL", async () => {
  // Upstream evaluates rules against `sender.tab.url`. A child resolving
  // locally would stop honouring a rule written for the page it lives in.
  const coordinator = new FrameCoordinator({
    root: null,
    resolveExclusion: () => ({ enabled: false, passKeys: "gj" }),
  });
  const child = attachFrame(coordinator, owns(0));
  await flush();

  coordinator.receive(child.frameId, {
    ...ENVELOPE,
    kind: "EXCLUSION_REQUEST",
    nonce: child.nonce,
    requestId: "req-x",
  });
  await flush();

  const [answer] = inboxOf(child, "EXCLUSION_RESULT");
  assert(answer !== undefined && answer.kind === "EXCLUSION_RESULT");
  assertEquals(answer.exclusion, { enabled: false, passKeys: "gj" });
  coordinator.dispose();
});

test("a throwing exclusion resolver degrades to enabled", async () => {
  const coordinator = new FrameCoordinator({
    root: null,
    resolveExclusion: () => {
      throw new Error("settings not hydrated yet");
    },
  });
  const child = attachFrame(coordinator, owns(0));
  await flush();

  const [greeting] = inboxOf(child, "WELCOME");
  assert(greeting !== undefined && greeting.kind === "WELCOME");
  assertEquals(greeting.exclusion, DEFAULT_EXCLUSION);
  coordinator.dispose();
});

test("frames may register at any time and the roster is republished", async () => {
  // `document-start` is unreliable on WebKit and iframes are inserted long
  // after load, so nothing may treat the frame list as final.
  const coordinator = new FrameCoordinator({ root: null });
  const first = attachFrame(coordinator, owns(0));
  await flush();
  assertEquals(coordinator.knownFrames(), ["f0000"]);

  const late = attachFrame(coordinator, owns(0));
  await flush();
  assertEquals(coordinator.knownFrames(), ["f0000", "f0001"]);

  const [roster] = inboxOf(first, "ROSTER").slice(-1);
  assert(roster !== undefined && roster.kind === "ROSTER");
  assertEquals(roster.frames, ["f0000", "f0001"]);

  coordinator.receive(late.frameId, {
    ...ENVELOPE,
    kind: "GOODBYE",
    nonce: late.nonce,
  });
  await flush();
  assertEquals(coordinator.knownFrames(), ["f0000"]);
  coordinator.dispose();
});

test("a silent frame cannot deadlock a hint round", async () => {
  // The headline requirement: sandboxed iframes, `about:blank` frames below
  // Safari 18.4, and 30fps-throttled cross-origin frames all simply never
  // answer. Takes the full `REQUEST_DEADLINE_MS` by construction.
  const coordinator = new FrameCoordinator({ root: null });
  const origin = attachFrame(coordinator, owns(0));
  attachFrame(coordinator, "silent");
  const responsive = attachFrame(coordinator, owns(1));
  await flush();

  const started = Date.now();
  coordinator.receive(origin.frameId, {
    ...ENVELOPE,
    kind: "REQUEST_HINTS",
    nonce: origin.nonce,
    requestId: "req-1",
    mode: "activate",
  });

  const descriptors = await new Promise<readonly RemoteHintDescriptor[]>(
    (resolve) => {
      const poll = setInterval(() => {
        const result = origin.inbox.find((m) => m.kind === "HINTS_RESULT");
        if (result === undefined || result.kind !== "HINTS_RESULT") return;
        clearInterval(poll);
        resolve(result.descriptors);
      }, 25);
    },
  );

  assertEquals(
    descriptors.map((d) => d.frameId),
    [responsive.frameId],
    "the round completes with whoever answered",
  );
  assert(
    Date.now() - started < 6000,
    "one deadline, not one deadline per frame",
  );
  coordinator.dispose();
});

// ---------------------------------------------------------------------------
// Degraded configuration
// ---------------------------------------------------------------------------

test("createFrameLink works with no DOM and no reachable top", async () => {
  const activated: Array<[number, HintMode]> = [];
  const bridge: LocalHintsBridge = {
    collectLocal: () => Promise.resolve([]),
    activateLocal: (localIndex, mode) => activated.push([localIndex, mode]),
    handleRemoteKey: () => {},
  };
  const link = createFrameLink({ isTop: false, localHints: bridge });

  assertEquals(await link.ready(), false);
  assertEquals(link.knownFrames(), [link.frameId]);
  assertEquals(await link.collectHints("activate"), []);
  // Never disabled by default: a frame that cannot reach the coordinator must
  // not silently stop responding to keys.
  assertEquals(await link.effectiveExclusion(), DEFAULT_EXCLUSION);

  // Our own hints still work, and without a round trip — `activate-new-tab` and
  // the clipboard modes would lose transient activation across two hops.
  link.activateHint(link.frameId, 3, "copy-link-url");
  assertEquals(activated, [[3, "copy-link-url"]]);

  link.broadcastKey("s");
  link.focusFrame(1);
  link.dispose();
});
