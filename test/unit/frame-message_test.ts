/**
 * The frame wire protocol.
 *
 * A message arrives from another window, so it is untrusted input. The
 * decoders take `unknown` and give an `Option`. A message that is not ours
 * must be dropped without a diagnosis, because building one for a hostile page
 * is work that the page did not pay for.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Boolean, Effect, flow, Option, Order, Record, Schema, pipe, Struct } from "effect";
import {
  compareDescriptors,
  DEFAULT_EXCLUSION,
  encodeMessage,
  ENVELOPE,
  type FrameMessage,
  type HintDescriptor,
  hintModeSchema,
  joinProofPayload,
  limitDescriptors,
  linkKeyPayload,
  MAX_DESCRIPTOR_PAYLOAD_BYTES,
  MAX_FRAME_DESCRIPTORS,
  MAX_SEAL_SEQUENCE,
  MAX_SEALED_LENGTH,
  MAX_SESSION_DESCRIPTORS,
  NO_REQUEST_ID,
  parseSealed,
  parseWelcome,
  parseWindowToTop,
  parseWire,
  peekKind,
  preauthorize,
  PROTOCOL_MAGIC,
  PROTOCOL_VERSION,
  sealedAad,
  sortDescriptors,
  welcomeSchema,
  WIRE_TARGET_ALL,
  WIRE_TARGET_TOP,
} from "~/domain/FrameMessage.ts";
import { FrameId } from "~/domain/FrameId.ts";

const NONCE = "abcdef0123456789";
const ROUND_ID = "round-1";

/** The frame that sends every routed message of these tests. */
const SENDER = FrameId.make("1111111111111111");

const envelope = {
  nonce: NONCE,
  from: SENDER,
  to: WIRE_TARGET_TOP,
  requestId: NO_REQUEST_ID,
};

const wire = (message: FrameMessage): unknown => encodeMessage(envelope, message);

/** A routed envelope with fields that no schema has checked. */
const raw = (fields: object): unknown =>
  pipe(ENVELOPE, Struct.assign(envelope), Struct.assign(fields));

/** The kind of a parsed message, when it parsed. */
const kindOf: (parsed: Option.Option<{ readonly kind: string }>) => Option.Option<string> =
  Option.map(({ kind }) => kind);

const descriptor = (frameId: string, localIndex: number, secondary = false): HintDescriptor => ({
  frameId: FrameId.make(frameId),
  localIndex,
  linkText: `link ${localIndex}`,
  secondary,
});

describe("FrameMessage", () => {
  it.effect("accepts a message of a kind that carries a payload", () =>
    Effect.sync(() => {
      const parsed = parseWire(
        wire({
          kind: "EXCLUSION_RESULT",
          exclusion: { enabled: false, passKeys: "jk" },
        }),
        Option.some(NONCE),
      );
      assert.deepEqual(kindOf(parsed), Option.some("EXCLUSION_RESULT"));
    }),
  );

  it.effect("accepts a hint round message with its descriptors", () =>
    Effect.sync(() => {
      const parsed = parseWire(
        wire({
          kind: "ACTIVATE",
          roundId: ROUND_ID,
          originFrameId: SENDER,
          mode: "activate",
          descriptors: [descriptor("1111111111111111", 0)],
        }),
        Option.some(NONCE),
      );
      assert.isTrue(Option.isSome(parsed));
    }),
  );

  it.effect.each([
    null,
    "a string",
    42,
    {},
    { magic: "somebody-else", v: PROTOCOL_VERSION, kind: "GOODBYE" },
  ])("refuses %j, which is not our envelope", (data) =>
    Effect.sync(() => {
      assert.isTrue(
        Option.isNone(parseWire(data, Option.some(NONCE))),
        `${JSON.stringify(data)} was accepted`,
      );
    }),
  );

  it.effect("refuses a protocol version that is not ours", () =>
    Effect.sync(() => {
      const foreign = pipe(
        { magic: PROTOCOL_MAGIC, v: PROTOCOL_VERSION + 1 },
        Struct.assign(envelope),
        Struct.assign({ kind: "GOODBYE" }),
      );
      assert.isTrue(Option.isNone(parseWire(foreign, Option.some(NONCE))));
    }),
  );

  it.effect("refuses an unknown kind", () =>
    Effect.sync(() => {
      const unknown = raw({ kind: "NO_SUCH_KIND" });
      assert.isTrue(Option.isNone(parseWire(unknown, Option.some(NONCE))));
    }),
  );

  it.effect("refuses a message whose payload is incomplete", () =>
    Effect.sync(() => {
      // `EXCLUSION_RESULT` needs an exclusion, and `KEYSTROKE` needs a
      // notation.
      const withoutExclusion = raw({ kind: "EXCLUSION_RESULT" });
      const withoutNotation = raw({ kind: "KEYSTROKE" });
      assert.isTrue(Option.isNone(parseWire(withoutExclusion, Option.some(NONCE))));
      assert.isTrue(Option.isNone(parseWire(withoutNotation, Option.some(NONCE))));
    }),
  );

  it.effect("refuses a payload that is past its bound", () =>
    Effect.sync(() => {
      const tooLong = raw({ kind: "KEYSTROKE", notation: "k".repeat(1000) });
      assert.isTrue(Option.isNone(parseWire(tooLong, Option.some(NONCE))));

      const negativeIndex = raw({
        kind: "ACTIVATE_HINT",
        roundId: ROUND_ID,
        localIndex: -1,
        mode: "activate",
      });
      assert.isTrue(Option.isNone(parseWire(negativeIndex, Option.some(NONCE))));
    }),
  );

  it.effect("drops a message whose nonce is wrong or absent", () =>
    Effect.sync(() => {
      const data = wire({ kind: "GOODBYE" });
      assert.isTrue(Option.isSome(parseWire(data, Option.some(NONCE))));
      assert.isTrue(Option.isNone(parseWire(data, Option.some("other"))));
      // A frame that is not yet admitted has no session to talk in.
      assert.isTrue(Option.isNone(parseWire(data, Option.none())));
    }),
  );

  it.effect("checks the nonce before it decodes", () =>
    Effect.sync(() => {
      const data = wire({ kind: "GOODBYE" });
      assert.isTrue(preauthorize(data, Option.some(NONCE)));
      assert.isFalse(preauthorize(data, Option.some("other")));
      assert.isFalse(preauthorize(data, Option.none()));
      assert.isFalse(preauthorize({ nonce: NONCE }, Option.some(NONCE)));
    }),
  );

  it.effect("reads the kind without a decode", () =>
    Effect.sync(() => {
      assert.deepEqual(peekKind(wire({ kind: "GOODBYE" })), Option.some("GOODBYE"));
      assert.isTrue(Option.isNone(peekKind({ magic: "other", kind: "X" })));
      assert.isTrue(Option.isNone(peekKind(ENVELOPE)));
    }),
  );

  it.effect("lets the handshake through with no nonce", () =>
    Effect.sync(() => {
      const hello = pipe(ENVELOPE, Struct.assign({ kind: "HELLO" }));
      assert.deepEqual(kindOf(parseWindowToTop(hello)), Option.some("HELLO"));
    }),
  );

  it.effect("refuses a JOIN that carries no proof", () =>
    Effect.sync(() => {
      const join = pipe(
        ENVELOPE,
        Struct.assign({
          kind: "JOIN",
          token: "0123456789abcdef",
          helloId: "fedcba9876543210",
          frameId: "1111111111111111",
        }),
      );
      assert.isTrue(Option.isNone(parseWindowToTop(join)));
    }),
  );

  it.effect("refuses a handshake value that is not hexadecimal", () =>
    Effect.gen(function* () {
      // The alphabet is a security control. `linkKeyPayload` joins the same
      // three values with the same separator, so a value that could hold a
      // separator or a letter would let one payload spell out the other.
      const join = (token: string) =>
        pipe(
          ENVELOPE,
          Struct.assign({
            kind: "JOIN",
            token,
            helloId: "fedcba9876543210",
            frameId: "1111111111111111",
            proof: "cHJvb2Y",
          }),
        );
      assert.isTrue(Option.isSome(parseWindowToTop(join("0123456789abcdef"))));
      yield* pipe(
        [
          "guessed",
          "short",
          "vimium-webkit/frames/link/v1:00000000",
          "0123456789abcde:",
          "0123456789ABCDEF",
        ],
        Effect.forEach((token) =>
          Effect.sync(() => {
            assert.isTrue(Option.isNone(parseWindowToTop(join(token))), `${token} was accepted`);
          }),
        ),
      );

      const challenge = pipe(
        ENVELOPE,
        Struct.assign({ kind: "CHALLENGE", token: "not hexadecimal" }),
      );
      assert.isTrue(Option.isNone(parseWindowToTop(challenge)));
    }),
  );

  it.effect("keeps the join proof and the link key apart", () =>
    Effect.sync(() => {
      // The proof travels in clear text. A derivation that signed the same
      // text would therefore publish the key of the link.
      const token = "0123456789abcdef";
      const helloId = "fedcba9876543210";
      const frameId = "1111111111111111";
      const proof = joinProofPayload(token, helloId, frameId);
      const key = linkKeyPayload(token, helloId, frameId);
      assert.notStrictEqual(proof, key);
      // A hexadecimal token can never spell the prefix of the key payload, so
      // no handshake that the schema accepts can make the two texts meet. The
      // label carries the version of the protocol, and not a version of its
      // own, so one number names the wire.
      assert.isTrue(key.startsWith(`${PROTOCOL_MAGIC}/link/v${PROTOCOL_VERSION}:`));
      assert.isFalse(/^[0-9a-f]/.test(key));
      assert.isTrue(/^[0-9a-f]/.test(proof));
    }),
  );

  it.effect("binds a sealed message to its link, direction and counter", () =>
    Effect.sync(() => {
      const first = sealedAad("fedcba9876543210", "up", 3);
      assert.notStrictEqual(first, sealedAad("fedcba9876543210", "down", 3));
      assert.notStrictEqual(first, sealedAad("fedcba9876543210", "up", 4));
      assert.notStrictEqual(first, sealedAad("0123456789abcdef", "up", 3));
      assert.isTrue(first.startsWith(`${PROTOCOL_MAGIC}/${PROTOCOL_VERSION}/`));
    }),
  );

  it.effect("parses a sealed envelope and refuses a broken one", () =>
    Effect.gen(function* () {
      const sealed = pipe(ENVELOPE, Struct.assign({ kind: "SEALED", seq: 0, data: "AAAA" }));
      const seq = pipe(
        sealed,
        parseSealed,
        Option.map((parsed) => parsed.seq),
      );
      assert.deepEqual(seq, Option.some(0));

      yield* pipe(
        [
          pipe(sealed, Struct.assign({ seq: -1 })),
          pipe(sealed, Struct.assign({ seq: MAX_SEAL_SEQUENCE + 1 })),
          pipe(sealed, Struct.assign({ seq: 1.5 })),
          pipe(sealed, Struct.assign({ data: 42 })),
          pipe(sealed, Struct.assign({ kind: "WELCOME" })),
          pipe(ENVELOPE, Struct.assign({ kind: "SEALED", seq: 0 })),
          { magic: "somebody-else", v: PROTOCOL_VERSION, kind: "SEALED" },
        ],
        Effect.forEach((broken) =>
          Effect.sync(() => {
            assert.isTrue(
              Option.isNone(parseSealed(broken)),
              `${JSON.stringify(broken)} was accepted`,
            );
          }),
        ),
      );
    }),
  );

  it.effect("refuses a WELCOME that a routed message forged", () =>
    Effect.sync(() => {
      assert.isTrue(Option.isNone(parseWelcome(wire({ kind: "GOODBYE" }))));

      const welcome = pipe(
        ENVELOPE,
        Struct.assign({
          kind: "WELCOME",
          nonce: NONCE,
          frameId: "1111111111111111",
          helloId: "fedcba9876543210",
          frames: ["1111111111111111"],
        }),
        Schema.encodeUnknownSync(welcomeSchema),
      );
      assert.isTrue(Option.isSome(parseWelcome(welcome)));
    }),
  );

  it.effect("signs the token, the hello id and the frame id together", () =>
    Effect.sync(() => {
      assert.strictEqual(joinProofPayload("t", "h", "f"), "t:h:f");
    }),
  );

  it.effect("orders descriptors by frame and then by local index", () =>
    Effect.sync(() => {
      const first = descriptor("aaaa", 1);
      const second = descriptor("aaaa", 2);
      const third = descriptor("bbbb", 0);
      assert.isBelow(compareDescriptors(first, second), 0);
      assert.isBelow(compareDescriptors(second, third), 0);
      assert.isAbove(compareDescriptors(third, first), 0);
    }),
  );

  it.effect("sorts into one total order and does not change its input", () =>
    Effect.sync(() => {
      const input = [descriptor("bbbb", 1), descriptor("aaaa", 2), descriptor("aaaa", 1, true)];
      const sorted = sortDescriptors(input);
      const order = pipe(
        sorted,
        Array.map((entry) => `${entry.frameId}:${entry.localIndex}`),
      );
      assert.deepEqual(order, ["aaaa:1", "aaaa:2", "bbbb:1"]);
      const firstInput = pipe(
        input,
        Array.head,
        Option.map(({ frameId }) => frameId),
      );
      assert.deepEqual(firstInput, Option.some("bbbb"));
    }),
  );

  it.effect.each(hintModeSchema.literals)("carries the hint mode %s over the wire", (mode) =>
    Effect.sync(() => {
      const parsed = parseWire(
        wire({
          kind: "COLLECT_HINTS",
          roundId: ROUND_ID,
          originFrameId: SENDER,
          mode,
        }),
        Option.some(NONCE),
      );
      assert.isTrue(Option.isSome(parsed), `${mode} did not survive`);
    }),
  );

  it.effect("keeps the two reserved routing targets apart", () =>
    Effect.sync(() => {
      assert.notStrictEqual(WIRE_TARGET_TOP, WIRE_TARGET_ALL);
      // A frame id is 16 hexadecimal characters, so it is neither word.
      assert.isBelow(WIRE_TARGET_TOP.length, 16);
      assert.isBelow(WIRE_TARGET_ALL.length, 16);
    }),
  );

  it.effect("stays enabled when the top frame never answers", () =>
    Effect.sync(() => {
      assert.deepEqual(DEFAULT_EXCLUSION, { enabled: true, passKeys: "" });
    }),
  );
});

/**
 * The bound of a round, and the bound of one frame.
 *
 * Three frames that each answer inside their own limit used to build one
 * merged message that the receiver refused, and the whole page lost its hints.
 * The merged list therefore has a bound of its own, and `limitDescriptors`
 * shares that bound between the frames.
 */
describe("the descriptors of a round", () => {
  const listFor = (frameId: string, count: number): readonly HintDescriptor[] =>
    pipe(
      Array.range(0, count - 1),
      Array.map((index) => descriptor(frameId, index)),
    );

  /** How many descriptors each frame keeps. */
  const countsByFrame: (
    entries: readonly HintDescriptor[],
  ) => Record.ReadonlyRecord<string, number> = flow(
    Array.groupBy((entry: HintDescriptor) => entry.frameId),
    Record.map(Array.length),
  );

  it.effect("keeps the merged answer of three frames", () =>
    Effect.gen(function* () {
      const merged = [
        ...listFor("1111111111111111", 2000),
        ...listFor("2222222222222222", 2000),
        ...listFor("3333333333333333", 2000),
      ];
      assert.isAbove(merged.length, MAX_FRAME_DESCRIPTORS);

      // Each frame answered inside its own limit, so each `HINTS` message is
      // valid. The merged message must be valid as well.
      yield* pipe(
        ["1111111111111111", "2222222222222222"],
        Effect.forEach((frameId) =>
          Effect.sync(() => {
            assert.isTrue(
              Option.isSome(
                parseWire(
                  wire({
                    kind: "HINTS",
                    roundId: ROUND_ID,
                    descriptors: listFor(frameId, 2000),
                  }),
                  Option.some(NONCE),
                ),
              ),
            );
          }),
        ),
      );
      assert.isTrue(
        Option.isSome(
          parseWire(
            wire({
              kind: "HINTS_RESULT",
              roundId: ROUND_ID,
              droppedDescriptors: 0,
              descriptors: merged,
            }),
            Option.some(NONCE),
          ),
        ),
      );
      assert.isTrue(
        Option.isSome(
          parseWire(
            wire({
              kind: "ACTIVATE",
              roundId: ROUND_ID,
              originFrameId: SENDER,
              mode: "activate",
              descriptors: merged,
            }),
            Option.some(NONCE),
          ),
        ),
      );
    }),
  );

  it.effect("keeps the bound of one frame on the answer of one frame", () =>
    Effect.sync(() => {
      const tooMany = listFor("1111111111111111", MAX_FRAME_DESCRIPTORS + 1);
      assert.isTrue(
        Option.isNone(
          parseWire(
            wire({
              kind: "HINTS",
              roundId: ROUND_ID,
              descriptors: tooMany,
            }),
            Option.some(NONCE),
          ),
        ),
      );
    }),
  );

  it.effect("changes nothing when the round fits", () =>
    Effect.sync(() => {
      const merged = [...listFor("2222222222222222", 3), ...listFor("1111111111111111", 2)];
      assert.deepEqual(limitDescriptors(merged), sortDescriptors(merged));
    }),
  );

  it.effect("shares the bound between the frames that ask for more", () =>
    Effect.sync(() => {
      const merged = [
        ...listFor("1111111111111111", 5000),
        ...listFor("2222222222222222", 5000),
        ...listFor("3333333333333333", 5000),
      ];
      const capped = limitDescriptors(merged);
      assert.strictEqual(capped.length, MAX_SESSION_DESCRIPTORS);

      // Eight thousand between three frames: two frames keep one more.
      const shares = pipe(capped, countsByFrame, Record.values, Array.sort(Order.Number));
      assert.deepEqual(shares, [2666, 2667, 2667]);
      // Every frame keeps a prefix of its own hints.
      const firstIndex = pipe(
        capped,
        Array.head,
        Option.map(({ localIndex }) => localIndex),
      );
      assert.deepEqual(firstIndex, Option.some(0));
    }),
  );

  it.effect("gives the unused share of a small frame to a large one", () =>
    Effect.sync(() => {
      const capped = limitDescriptors([
        ...listFor("1111111111111111", 10),
        ...listFor("2222222222222222", 20000),
      ]);
      const kept = countsByFrame(capped);
      const small = pipe(kept, Record.get("1111111111111111"));
      const large = pipe(kept, Record.get("2222222222222222"));
      assert.deepEqual(small, Option.some(10));
      assert.deepEqual(large, Option.some(MAX_SESSION_DESCRIPTORS - 10));
    }),
  );

  it.effect("keeps multibyte and escaped labels inside the sealed limit", () =>
    Effect.sync(() => {
      /** Alternate labels of four-byte characters and of escaped characters. */
      const costlyText = (index: number): string =>
        pipe(
          index % 2 === 0,
          Boolean.match({
            onTrue: () => "😀".repeat(128),
            onFalse: () => "\\\n\t".repeat(64),
          }),
        );
      const costly = pipe(
        MAX_SESSION_DESCRIPTORS,
        Array.makeBy((index) =>
          pipe(
            descriptor("1111111111111111", index),
            Struct.assign({ linkText: costlyText(index) }),
          ),
        ),
      );
      const kept = limitDescriptors(costly, MAX_SESSION_DESCRIPTORS, MAX_DESCRIPTOR_PAYLOAD_BYTES);
      assert.isBelow(kept.length, costly.length);

      const message = wire({
        kind: "HINTS_RESULT",
        roundId: ROUND_ID,
        droppedDescriptors: costly.length - kept.length,
        descriptors: kept,
      });
      const plainBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
      const sealedLength = Math.ceil(((plainBytes + 16) * 4) / 3);
      assert.isAtMost(sealedLength, MAX_SEALED_LENGTH);
      const sealed = pipe(
        ENVELOPE,
        Struct.assign({ kind: "SEALED", seq: 0, data: "A".repeat(sealedLength) }),
        parseSealed,
      );
      assert.isTrue(Option.isSome(sealed));
      assert.isTrue(Option.isSome(parseWire(message, Option.some(NONCE))));
    }),
  );

  it.effect("gives every frame the same list of the round", () =>
    Effect.sync(() => {
      const mine = listFor("2222222222222222", 5000);
      const capped = limitDescriptors([
        ...listFor("1111111111111111", 5000),
        ...mine,
        ...listFor("3333333333333333", 5000),
      ]);

      // What the top frame sends to frame 2222: the merged list, with the
      // descriptors of the receiver taken out. The receiver puts its own full
      // list back, and must work out the same round.
      const asReceiverSees = pipe(
        capped,
        Array.filter((entry) => entry.frameId !== "2222222222222222"),
        Array.appendAll(mine),
      );
      assert.deepEqual(limitDescriptors(asReceiverSees), capped);
    }),
  );
});
