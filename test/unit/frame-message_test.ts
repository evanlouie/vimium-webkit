/**
 * The frame wire protocol.
 *
 * A message arrives from another window, so it is untrusted input. The
 * decoders take `unknown` and give an `Option`. A message that is not ours
 * must be dropped without a diagnosis, because building one for a hostile page
 * is work that the page did not pay for.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
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
  MAX_FRAME_DESCRIPTORS,
  MAX_SEAL_SEQUENCE,
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

const NONCE = "abcdef0123456789";

const envelope = {
  nonce: NONCE,
  from: "1111111111111111",
  to: WIRE_TARGET_TOP,
  requestId: NO_REQUEST_ID,
};

const wire = (message: FrameMessage): unknown =>
  encodeMessage(envelope, message);

const descriptor = (
  frameId: string,
  localIndex: number,
  secondary = false,
): HintDescriptor => ({
  frameId,
  localIndex,
  linkText: `link ${localIndex}`,
  secondary,
});

describe("FrameMessage", () => {
  it.effect("puts a message in its envelope", () =>
    Effect.sync(() => {
      const encoded = encodeMessage(envelope, { kind: "GOODBYE" });
      assert.strictEqual(encoded.magic, PROTOCOL_MAGIC);
      assert.strictEqual(encoded.v, PROTOCOL_VERSION);
      assert.strictEqual(encoded.kind, "GOODBYE");
      assert.strictEqual(encoded.nonce, NONCE);
      assert.strictEqual(ENVELOPE.magic, PROTOCOL_MAGIC);
    }));

  it.effect("accepts a message of a kind that carries a payload", () =>
    Effect.sync(() => {
      const parsed = parseWire(
        wire({
          kind: "EXCLUSION_RESULT",
          exclusion: { enabled: false, passKeys: "jk" },
        }),
        Option.some(NONCE),
      );
      assert.isTrue(Option.isSome(parsed));
      if (Option.isNone(parsed)) return;
      assert.strictEqual(parsed.value.kind, "EXCLUSION_RESULT");
    }));

  it.effect("accepts a hint round message with its descriptors", () =>
    Effect.sync(() => {
      const parsed = parseWire(
        wire({
          kind: "ACTIVATE",
          originFrameId: "1111111111111111",
          mode: "activate",
          descriptors: [descriptor("1111111111111111", 0)],
        }),
        Option.some(NONCE),
      );
      assert.isTrue(Option.isSome(parsed));
    }));

  it.effect("refuses anything that is not our envelope", () =>
    Effect.sync(() => {
      for (
        const data of [
          null,
          "a string",
          42,
          {},
          { magic: "somebody-else", v: PROTOCOL_VERSION, kind: "GOODBYE" },
        ]
      ) {
        assert.isTrue(
          Option.isNone(parseWire(data, Option.some(NONCE))),
          `${JSON.stringify(data)} was accepted`,
        );
      }
    }));

  it.effect("refuses a protocol version that is not ours", () =>
    Effect.sync(() => {
      const foreign = {
        magic: PROTOCOL_MAGIC,
        v: PROTOCOL_VERSION + 1,
        ...envelope,
        kind: "GOODBYE",
      };
      assert.isTrue(Option.isNone(parseWire(foreign, Option.some(NONCE))));
    }));

  it.effect("refuses an unknown kind", () =>
    Effect.sync(() => {
      const unknown = { ...ENVELOPE, ...envelope, kind: "NO_SUCH_KIND" };
      assert.isTrue(Option.isNone(parseWire(unknown, Option.some(NONCE))));
    }));

  it.effect("refuses a message whose payload is incomplete", () =>
    Effect.sync(() => {
      // `EXCLUSION_RESULT` needs an exclusion, and `KEYSTROKE` needs a
      // notation.
      const withoutExclusion = {
        ...ENVELOPE,
        ...envelope,
        kind: "EXCLUSION_RESULT",
      };
      const withoutNotation = { ...ENVELOPE, ...envelope, kind: "KEYSTROKE" };
      assert.isTrue(
        Option.isNone(parseWire(withoutExclusion, Option.some(NONCE))),
      );
      assert.isTrue(
        Option.isNone(parseWire(withoutNotation, Option.some(NONCE))),
      );
    }));

  it.effect("refuses a payload that is past its bound", () =>
    Effect.sync(() => {
      const tooLong = {
        ...ENVELOPE,
        ...envelope,
        kind: "KEYSTROKE",
        notation: "k".repeat(1000),
      };
      assert.isTrue(Option.isNone(parseWire(tooLong, Option.some(NONCE))));

      const negativeIndex = {
        ...ENVELOPE,
        ...envelope,
        kind: "ACTIVATE_HINT",
        localIndex: -1,
        mode: "activate",
      };
      assert.isTrue(
        Option.isNone(parseWire(negativeIndex, Option.some(NONCE))),
      );
    }));

  it.effect("drops a message whose nonce is wrong or absent", () =>
    Effect.sync(() => {
      const data = wire({ kind: "GOODBYE" });
      assert.isTrue(Option.isSome(parseWire(data, Option.some(NONCE))));
      assert.isTrue(Option.isNone(parseWire(data, Option.some("other"))));
      // A frame that is not yet admitted has no session to talk in.
      assert.isTrue(Option.isNone(parseWire(data, Option.none())));
    }));

  it.effect("checks the nonce before it decodes", () =>
    Effect.sync(() => {
      const data = wire({ kind: "GOODBYE" });
      assert.isTrue(preauthorize(data, Option.some(NONCE)));
      assert.isFalse(preauthorize(data, Option.some("other")));
      assert.isFalse(preauthorize(data, Option.none()));
      assert.isFalse(preauthorize({ nonce: NONCE }, Option.some(NONCE)));
    }));

  it.effect("reads the kind without a decode", () =>
    Effect.sync(() => {
      assert.deepEqual(
        peekKind(wire({ kind: "GOODBYE" })),
        Option.some("GOODBYE"),
      );
      assert.isTrue(Option.isNone(peekKind({ magic: "other", kind: "X" })));
      assert.isTrue(Option.isNone(peekKind({ ...ENVELOPE })));
    }));

  it.effect("lets the handshake through with no nonce", () =>
    Effect.sync(() => {
      const hello = { ...ENVELOPE, kind: "HELLO" };
      const parsed = parseWindowToTop(hello);
      assert.isTrue(Option.isSome(parsed));
      if (Option.isNone(parsed)) return;
      assert.strictEqual(parsed.value.kind, "HELLO");
    }));

  it.effect("refuses a JOIN that carries no proof", () =>
    Effect.sync(() => {
      const join = {
        ...ENVELOPE,
        kind: "JOIN",
        token: "0123456789abcdef",
        helloId: "fedcba9876543210",
        frameId: "1111111111111111",
      };
      assert.isTrue(Option.isNone(parseWindowToTop(join)));
    }));

  it.effect("refuses a handshake value that is not hexadecimal", () =>
    Effect.sync(() => {
      // The alphabet is a security control. `linkKeyPayload` joins the same
      // three values with the same separator, so a value that could hold a
      // separator or a letter would let one payload spell out the other.
      const join = (token: string) => ({
        ...ENVELOPE,
        kind: "JOIN",
        token,
        helloId: "fedcba9876543210",
        frameId: "1111111111111111",
        proof: "cHJvb2Y",
      });
      assert.isTrue(Option.isSome(parseWindowToTop(join("0123456789abcdef"))));
      for (
        const token of [
          "guessed",
          "short",
          "vimium-webkit/frames/link/v1:00000000",
          "0123456789abcde:",
          "0123456789ABCDEF",
        ]
      ) {
        assert.isTrue(
          Option.isNone(parseWindowToTop(join(token))),
          `${token} was accepted`,
        );
      }

      const challenge = {
        ...ENVELOPE,
        kind: "CHALLENGE",
        token: "not hexadecimal",
      };
      assert.isTrue(Option.isNone(parseWindowToTop(challenge)));
    }));

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
      assert.isTrue(
        key.startsWith(`${PROTOCOL_MAGIC}/link/v${PROTOCOL_VERSION}:`),
      );
      assert.isFalse(/^[0-9a-f]/.test(key));
      assert.isTrue(/^[0-9a-f]/.test(proof));
    }));

  it.effect("binds a sealed message to its link, direction and counter", () =>
    Effect.sync(() => {
      const first = sealedAad("fedcba9876543210", "up", 3);
      assert.notStrictEqual(first, sealedAad("fedcba9876543210", "down", 3));
      assert.notStrictEqual(first, sealedAad("fedcba9876543210", "up", 4));
      assert.notStrictEqual(first, sealedAad("0123456789abcdef", "up", 3));
      assert.isTrue(first.startsWith(`${PROTOCOL_MAGIC}/${PROTOCOL_VERSION}/`));
    }));

  it.effect("parses a sealed envelope and refuses a broken one", () =>
    Effect.sync(() => {
      const sealed = { ...ENVELOPE, kind: "SEALED", seq: 0, data: "AAAA" };
      const parsed = parseSealed(sealed);
      assert.isTrue(Option.isSome(parsed));
      if (Option.isNone(parsed)) return;
      assert.strictEqual(parsed.value.seq, 0);

      for (
        const broken of [
          { ...sealed, seq: -1 },
          { ...sealed, seq: MAX_SEAL_SEQUENCE + 1 },
          { ...sealed, seq: 1.5 },
          { ...sealed, data: 42 },
          { ...sealed, kind: "WELCOME" },
          { ...ENVELOPE, kind: "SEALED", seq: 0 },
          { magic: "somebody-else", v: PROTOCOL_VERSION, kind: "SEALED" },
        ]
      ) {
        assert.isTrue(
          Option.isNone(parseSealed(broken)),
          `${JSON.stringify(broken)} was accepted`,
        );
      }
    }));

  it.effect("refuses a WELCOME that a routed message forged", () =>
    Effect.sync(() => {
      assert.isTrue(Option.isNone(parseWelcome(wire({ kind: "GOODBYE" }))));

      const welcome = Schema.encodeUnknownSync(welcomeSchema)({
        ...ENVELOPE,
        kind: "WELCOME",
        nonce: NONCE,
        frameId: "1111111111111111",
        helloId: "fedcba9876543210",
        frames: ["1111111111111111"],
      });
      assert.isTrue(Option.isSome(parseWelcome(welcome)));
    }));

  it.effect("signs the token, the hello id and the frame id together", () =>
    Effect.sync(() => {
      assert.strictEqual(joinProofPayload("t", "h", "f"), "t:h:f");
    }));

  it.effect("orders descriptors by frame and then by local index", () =>
    Effect.sync(() => {
      const first = descriptor("aaaa", 1);
      const second = descriptor("aaaa", 2);
      const third = descriptor("bbbb", 0);
      assert.isBelow(compareDescriptors(first, second), 0);
      assert.isBelow(compareDescriptors(second, third), 0);
      assert.isAbove(compareDescriptors(third, first), 0);
    }));

  it.effect("sorts into one total order and does not change its input", () =>
    Effect.sync(() => {
      const input = [
        descriptor("bbbb", 1),
        descriptor("aaaa", 2),
        descriptor("aaaa", 1, true),
      ];
      const sorted = sortDescriptors(input);
      assert.deepEqual(
        sorted.map((entry) => `${entry.frameId}:${entry.localIndex}`),
        ["aaaa:1", "aaaa:2", "bbbb:1"],
      );
      assert.strictEqual(input[0]?.frameId, "bbbb");
    }));

  it.effect("carries every hint mode over the wire", () =>
    Effect.sync(() => {
      for (const mode of hintModeSchema.literals) {
        const parsed = parseWire(
          wire({ kind: "COLLECT_HINTS", mode }),
          Option.some(NONCE),
        );
        assert.isTrue(Option.isSome(parsed), `${mode} did not survive`);
      }
    }));

  it.effect("keeps the two reserved routing targets apart", () =>
    Effect.sync(() => {
      assert.notStrictEqual(WIRE_TARGET_TOP, WIRE_TARGET_ALL);
      // A frame id is 16 hexadecimal characters, so it is neither word.
      assert.isBelow(WIRE_TARGET_TOP.length, 16);
      assert.isBelow(WIRE_TARGET_ALL.length, 16);
    }));

  it.effect("stays enabled when the top frame never answers", () =>
    Effect.sync(() => {
      assert.deepEqual(DEFAULT_EXCLUSION, { enabled: true, passKeys: "" });
    }));
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
  const listFor = (
    frameId: string,
    count: number,
  ): readonly HintDescriptor[] =>
    Array.from({ length: count }, (_, index) => descriptor(frameId, index));

  it.effect("keeps the merged answer of three frames", () =>
    Effect.sync(() => {
      const merged = [
        ...listFor("1111111111111111", 2000),
        ...listFor("2222222222222222", 2000),
        ...listFor("3333333333333333", 2000),
      ];
      assert.isAbove(merged.length, MAX_FRAME_DESCRIPTORS);

      // Each frame answered inside its own limit, so each `HINTS` message is
      // valid. The merged message must be valid as well.
      for (const frameId of ["1111111111111111", "2222222222222222"]) {
        assert.isTrue(Option.isSome(parseWire(
          wire({ kind: "HINTS", descriptors: listFor(frameId, 2000) }),
          Option.some(NONCE),
        )));
      }
      assert.isTrue(Option.isSome(parseWire(
        wire({ kind: "HINTS_RESULT", descriptors: merged }),
        Option.some(NONCE),
      )));
      assert.isTrue(Option.isSome(parseWire(
        wire({
          kind: "ACTIVATE",
          originFrameId: "1111111111111111",
          mode: "activate",
          descriptors: merged,
        }),
        Option.some(NONCE),
      )));
    }));

  it.effect("keeps the bound of one frame on the answer of one frame", () =>
    Effect.sync(() => {
      const tooMany = listFor("1111111111111111", MAX_FRAME_DESCRIPTORS + 1);
      assert.isTrue(Option.isNone(parseWire(
        wire({ kind: "HINTS", descriptors: tooMany }),
        Option.some(NONCE),
      )));
    }));

  it.effect("changes nothing when the round fits", () =>
    Effect.sync(() => {
      const merged = [
        ...listFor("2222222222222222", 3),
        ...listFor("1111111111111111", 2),
      ];
      assert.deepEqual(limitDescriptors(merged), sortDescriptors(merged));
    }));

  it.effect("shares the bound between the frames that ask for more", () =>
    Effect.sync(() => {
      const merged = [
        ...listFor("1111111111111111", 5000),
        ...listFor("2222222222222222", 5000),
        ...listFor("3333333333333333", 5000),
      ];
      const capped = limitDescriptors(merged);
      assert.strictEqual(capped.length, MAX_SESSION_DESCRIPTORS);

      const kept = new Map<string, number>();
      for (const entry of capped) {
        kept.set(entry.frameId, (kept.get(entry.frameId) ?? 0) + 1);
      }
      // Eight thousand between three frames: two frames keep one more.
      assert.deepEqual(
        [...kept.values()].sort((left, right) => left - right),
        [2666, 2667, 2667],
      );
      // Every frame keeps a prefix of its own hints.
      assert.strictEqual(capped[0]?.localIndex, 0);
    }));

  it.effect("gives the unused share of a small frame to a large one", () =>
    Effect.sync(() => {
      const capped = limitDescriptors([
        ...listFor("1111111111111111", 10),
        ...listFor("2222222222222222", 20000),
      ]);
      const kept = new Map<string, number>();
      for (const entry of capped) {
        kept.set(entry.frameId, (kept.get(entry.frameId) ?? 0) + 1);
      }
      assert.strictEqual(kept.get("1111111111111111"), 10);
      assert.strictEqual(
        kept.get("2222222222222222"),
        MAX_SESSION_DESCRIPTORS - 10,
      );
    }));

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
      const asReceiverSees = [
        ...capped.filter((entry) => entry.frameId !== "2222222222222222"),
        ...mine,
      ];
      assert.deepEqual(limitDescriptors(asReceiverSees), capped);
    }));
});
