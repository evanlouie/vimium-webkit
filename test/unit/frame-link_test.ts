/**
 * The sealed link of one port.
 *
 * A page reads every `message` event that a window of the page receives, so it
 * takes a copy of the `MessagePort` that a `JOIN` transfers. The link is what
 * makes that copy worthless. These tests hold a real `MessageChannel`, and they
 * play the part of the page on it: they read the traffic, they send a message
 * that is not sealed, they send a sealed message again, they send a message
 * back to the frame that made it, and they flood the port.
 *
 * The ciphers come from two `FrameAuth` instances over one store, which is the
 * value store of a userscript manager as two frames of a page see it.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, Option, Queue, Scope, Stream } from "effect";
import { References } from "effect";
import {
  ENVELOPE,
  type FrameWire,
  NO_REQUEST_ID,
  WIRE_TARGET_TOP,
} from "~/domain/FrameMessage.ts";
import { FrameAuth, type FrameHandshake } from "~/frames/Auth.ts";
import {
  type Link,
  MAILBOX_CAPACITY,
  makeSealedLink,
  type PortHost,
} from "~/frames/Bus.ts";
import { KeyValueStore } from "~/platform/KeyValueStore.ts";
import { type FrameId, Realm } from "~/platform/Realm.ts";
import { Storage } from "~/platform/Storage.ts";

const TOP_FRAME = "1111111111111111";
const CHILD_FRAME = "2222222222222222";

const HANDSHAKE: FrameHandshake = {
  token: "0123456789abcdef",
  helloId: "fedcba9876543210",
  frameId: CHILD_FRAME,
};

/** One message of the routed protocol, as a child sends it. */
const wire = (notation: string): FrameWire => ({
  ...ENVELOPE,
  nonce: "abcdef0123456789",
  from: CHILD_FRAME,
  to: WIRE_TARGET_TOP,
  requestId: NO_REQUEST_ID,
  kind: "KEYSTROKE",
  notation,
});

/** The store that every frame of the page reads. */
const storeLayer: Layer.Layer<KeyValueStore> = Layer.sync(
  KeyValueStore,
  () => {
    const map = new Map<string, string>();
    return KeyValueStore.of({
      kind: "gm-sync",
      durable: true,
      watchable: false,
      managerPrivate: true,
      get: (key) =>
        Effect.sync(() => Option.fromNullishOr(map.get(key) ?? null)),
      set: (key, value) =>
        Effect.sync(() => {
          map.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          map.delete(key);
        }),
      setUnsafe: (key, value) => {
        map.set(key, value);
      },
      changes: () => Stream.empty,
    });
  },
);

const realmLayer = (isTop: boolean, frameId: string): Layer.Layer<Realm> =>
  Layer.succeed(
    Realm,
    Realm.of({
      frameId: frameId as FrameId,
      isTop,
      isLive: true,
      wakeDescendants: Effect.void,
      askDescendantsToAnnounce: Effect.void,
      isAncestor: () => Effect.succeed(false),
    }),
  );

/**
 * One frame, over the shared store.
 *
 * `Layer.fresh`, because a test builds two frames in one fiber and the layer of
 * a service is otherwise built once and shared.
 */
const frameLayer = (
  kv: Layer.Layer<KeyValueStore>,
  isTop: boolean,
  frameId: string,
): Layer.Layer<FrameAuth> =>
  Layer.fresh(FrameAuth.layer).pipe(
    Layer.provide(Layer.mergeAll(
      Layer.fresh(Storage.layer).pipe(Layer.provide(kv)),
      kv,
      realmLayer(isTop, frameId),
    )),
  );

/** A host for a port, with no document. The listener runs to completion. */
const host: PortHost = {
  listenOn: <R>(
    target: EventTarget,
    type: string,
    handler: (event: Event) => Effect.Effect<void, never, R>,
  ): Effect.Effect<void, never, R | Scope.Scope> =>
    Effect.gen(function*() {
      const context = yield* Effect.context<R>();
      const run = Effect.runSyncExitWith(context);
      const listen = (event: Event): void => {
        run(handler(event));
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          target.addEventListener(type, listen);
        }),
        () =>
          Effect.sync(() => {
            target.removeEventListener(type, listen);
          }),
      );
    }),
};

/** What the page sees on the wire, and what a link delivers. */
interface Watch {
  readonly raw: Queue.Queue<unknown>;
  readonly delivered: Queue.Queue<unknown>;
}

const makeWatch: Effect.Effect<Watch> = Effect.gen(function*() {
  const raw = yield* Queue.unbounded<unknown>();
  const delivered = yield* Queue.unbounded<unknown>();
  return { raw, delivered };
});

/** Read one value, or give `None` after a short wait on the real clock. */
const nextOf = <A>(queue: Queue.Queue<A>): Effect.Effect<Option.Option<A>> =>
  Effect.timeoutOrElse(Effect.map(Queue.take(queue), Option.some), {
    duration: "500 millis",
    orElse: () => Effect.succeed(Option.none<A>()),
  });

/** Nothing must arrive. A shorter wait, because this is the usual answer. */
const nothingOf = <A>(queue: Queue.Queue<A>): Effect.Effect<boolean> =>
  Effect.timeoutOrElse(Effect.as(Queue.take(queue), false), {
    duration: "200 millis",
    orElse: () => Effect.succeed(true),
  });

describe("the sealed link of a port", () => {
  it.live("carries a message that only the other end can read", () =>
    Effect.gen(function*() {
      const kv = storeLayer;
      const watch = yield* makeWatch;

      yield* Effect.gen(function*() {
        const top = yield* FrameAuth;
        const topCipher = yield* top.cipher(HANDSHAKE);

        yield* Effect.gen(function*() {
          const child = yield* FrameAuth;
          const childCipher = yield* child.cipher(HANDSHAKE);

          const channel = new MessageChannel();
          // The page holds a copy of the port that travelled. It reads every
          // message that our two frames exchange.
          channel.port2.addEventListener("message", (event) => {
            Queue.offerUnsafe(watch.raw, (event as MessageEvent).data);
          });

          const childLink: Link = yield* makeSealedLink(
            host,
            channel.port1,
            childCipher,
            "up",
            () => Effect.void,
          );
          const topLink: Link = yield* makeSealedLink(
            host,
            channel.port2,
            topCipher,
            "down",
            (data) =>
              Effect.sync(() => {
                Queue.offerUnsafe(watch.delivered, data);
              }),
          );

          yield* childLink.send(wire("a"));

          const arrived = yield* nextOf(watch.delivered);
          assert.isTrue(Option.isSome(arrived));
          if (Option.isNone(arrived)) return;
          assert.deepEqual(arrived.value, wire("a"));

          // The same message, as the page saw it.
          const seen = yield* nextOf(watch.raw);
          assert.isTrue(Option.isSome(seen));
          if (Option.isNone(seen)) return;
          const sealed = seen.value as Record<string, unknown>;
          assert.strictEqual(sealed["kind"], "SEALED");
          assert.strictEqual(sealed["seq"], 0);
          assert.notInclude(JSON.stringify(sealed), "KEYSTROKE");
          assert.notInclude(JSON.stringify(sealed), "notation");

          // A second message takes the next counter, so nothing repeats.
          yield* childLink.send(wire("b"));
          yield* nextOf(watch.delivered);
          const second = yield* nextOf(watch.raw);
          assert.isTrue(Option.isSome(second));
          if (Option.isNone(second)) return;
          assert.strictEqual(
            (second.value as Record<string, unknown>)["seq"],
            1,
          );

          // The link of the top frame answers on the same port.
          yield* topLink.send(wire("c"));
        }).pipe(Effect.provide(frameLayer(kv, false, CHILD_FRAME)));
      }).pipe(Effect.provide(frameLayer(kv, true, TOP_FRAME)));
    }));

  it.live("refuses a forged, a repeated and a reflected message", () =>
    Effect.gen(function*() {
      const kv = storeLayer;
      const watch = yield* makeWatch;
      /** What the page saw on the wire. */
      const onWire = yield* Queue.unbounded<unknown>();

      yield* Effect.gen(function*() {
        const top = yield* FrameAuth;
        const topCipher = yield* top.cipher(HANDSHAKE);

        yield* Effect.gen(function*() {
          const child = yield* FrameAuth;
          const childCipher = yield* child.cipher(HANDSHAKE);

          const channel = new MessageChannel();
          channel.port2.addEventListener("message", (event) => {
            Queue.offerUnsafe(onWire, (event as MessageEvent).data);
          });

          const childLink = yield* makeSealedLink(
            host,
            channel.port1,
            childCipher,
            "up",
            (data) =>
              Effect.sync(() => {
                Queue.offerUnsafe(watch.delivered, data);
              }),
          );
          yield* makeSealedLink(
            host,
            channel.port2,
            topCipher,
            "down",
            (data) =>
              Effect.sync(() => {
                Queue.offerUnsafe(watch.raw, data);
              }),
          );

          // 1. A message that is not sealed. This is the shape that a page
          //    would send if the port were the only thing that admitted it.
          channel.port2.postMessage({
            ...ENVELOPE,
            kind: "WELCOME",
            nonce: "abcdef0123456789",
            frameId: CHILD_FRAME,
            helloId: HANDSHAKE.helloId,
            frames: [TOP_FRAME],
          });
          assert.isTrue(
            yield* nothingOf(watch.delivered),
            "a message that was not sealed reached the frame",
          );

          // 2. A sealed message that the page kept and sent to the top frame
          //    again. A post on `port1` reaches the link of the top frame.
          yield* childLink.send(wire("a"));
          const seen = yield* nextOf(watch.raw);
          assert.isTrue(Option.isSome(seen));
          const kept = yield* nextOf(onWire);
          assert.isTrue(Option.isSome(kept));
          if (Option.isNone(kept)) return;
          channel.port1.postMessage(kept.value);
          assert.isTrue(
            yield* nothingOf(watch.raw),
            "a message that was sent again reached the frame",
          );

          // 3. The same message, sent back to the frame that made it. A post
          //    on `port2` reaches the link of the child. The direction is part
          //    of what the seal binds, so the message does not open there.
          channel.port2.postMessage(kept.value);
          assert.isTrue(
            yield* nothingOf(watch.delivered),
            "a message came back to its sender",
          );
        }).pipe(Effect.provide(frameLayer(kv, false, CHILD_FRAME)));
      }).pipe(Effect.provide(frameLayer(kv, true, TOP_FRAME)));
    }));

  it.live("drops a flood, keeps the memory bounded and says so", () =>
    Effect.gen(function*() {
      const kv = storeLayer;
      const delivered = yield* Queue.unbounded<unknown>();
      /** Every line that the link logged. */
      const logged: string[] = [];
      const capture = Logger.make<unknown, void>(({ message }) => {
        logged.push(String(message));
      });

      /** More messages than the mailbox holds, in one synchronous burst. */
      const FLOOD = MAILBOX_CAPACITY + 40;

      yield* Effect.gen(function*() {
        const top = yield* FrameAuth;
        const topCipher = yield* top.cipher(HANDSHAKE);

        yield* Effect.gen(function*() {
          const child = yield* FrameAuth;
          const childCipher = yield* child.cipher(HANDSHAKE);

          const channel = new MessageChannel();
          yield* makeSealedLink(
            host,
            channel.port2,
            topCipher,
            "down",
            (data) =>
              Effect.sync(() => {
                Queue.offerUnsafe(delivered, data);
              }),
          );

          // The page holds a copy of the port, so it decides how fast messages
          // arrive. Each message is sealed and every counter rises, so nothing
          // here is refused for any reason but the ceiling of the mailbox.
          const flood: unknown[] = [];
          for (let seq = 0; seq < FLOOD; seq += 1) {
            flood.push(
              yield* childCipher.seal("up", seq, JSON.stringify(wire("a"))),
            );
          }

          // One synchronous burst. No fiber of the link can run inside this
          // loop, so the mailbox holds everything that it accepts.
          yield* Effect.sync(() => {
            for (const sealed of flood) {
              channel.port2.dispatchEvent(
                new MessageEvent("message", { data: sealed }),
              );
            }
          });

          let count = 0;
          while (Option.isSome(yield* nextOf(delivered))) count += 1;
          assert.strictEqual(
            count,
            MAILBOX_CAPACITY,
            "the mailbox took more messages than it may hold",
          );

          // The link reports the drop.
          assert.isTrue(
            logged.some((line) => line.includes("mailbox")),
            "the link dropped a message and said nothing",
          );

          // A drop leaves a gap in the counter, and a gap is safe. The counter
          // only has to rise, so the next true message still opens.
          const later = yield* childCipher.seal(
            "up",
            FLOOD + 1,
            JSON.stringify(wire("b")),
          );
          channel.port2.dispatchEvent(
            new MessageEvent("message", { data: later }),
          );
          const arrived = yield* nextOf(delivered);
          assert.isTrue(
            Option.isSome(arrived),
            "a message after the flood did not arrive",
          );
          if (Option.isNone(arrived)) return;
          assert.deepEqual(arrived.value, wire("b"));
        }).pipe(Effect.provide(frameLayer(kv, false, CHILD_FRAME)));
      }).pipe(
        Effect.provide(frameLayer(kv, true, TOP_FRAME)),
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    }));
});
