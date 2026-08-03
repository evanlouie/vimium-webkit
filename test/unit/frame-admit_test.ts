/**
 * The admission of a `JOIN`, as the coordinator runs it.
 *
 * Two properties are checked here, and each one is a defect that a review
 * found:
 *
 * 1. The coordinator admits the joins of one child in the order that they
 *    arrived. A child that announces itself again closes the port of the
 *    attempt before it. Only the join that arrived last therefore carries a
 *    port that the child still holds. An admission in another order leaves the
 *    frame outside the session for the life of the document.
 * 2. A full join queue drops its oldest entry, and never the newest one. Page
 *    code can send a `JOIN` at any rate. A queue that dropped the newest entry
 *    would throw away exactly the join that property 1 protects.
 *
 * The test drives the real `FrameBus` of a top frame over a fake window tree
 * and a real `MessageChannel`. It plays the part of a child frame: it
 * announces itself, and it reads the challenge. It then signs a proof with a
 * second `FrameAuth` over the same store, and it transfers a port.
 *
 * The proof of the first join is made slow. Web Crypto and the value store are
 * both asynchronous, and neither one promises to answer two calls in the order
 * that it received them. The coordinator must give the same result whatever
 * each join costs.
 */

import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Result,
  Scope,
  Stream,
} from "effect";
import { ENVELOPE } from "~/domain/FrameMessage.ts";
import {
  FrameAuth,
  type FrameCipher,
  type FrameHandshake,
} from "~/frames/Auth.ts";
import {
  FrameBus,
  makeSealedLink,
  MAX_PENDING_JOINS,
  type PortHost,
  toFrame,
} from "~/frames/Bus.ts";
import {
  Dom,
  type Listener,
  type ListenOptions,
  type TargetEventMap,
} from "~/platform/Dom.ts";
import { KeyValueStore } from "~/platform/KeyValueStore.ts";
import { type FrameId, Realm } from "~/platform/Realm.ts";

const TOP_FRAME = "1111111111111111";
const CHILD_FRAME = "2222222222222222";
const CHILD_ORIGIN = "https://child.example";

/** The two attempts of the child, in the order that it makes them. */
const HELLO_FIRST = "aaaaaaaaaaaaaaaa";
const HELLO_SECOND = "bbbbbbbbbbbbbbbb";

/** How long the proof of the first attempt takes. */
const SLOW_PROOF = "120 millis";

// ---------------------------------------------------------------------------
// The page: a window tree with no browser
// ---------------------------------------------------------------------------

/** What a window of the fake tree received on `postMessage`. */
interface Post {
  readonly data: unknown;
  readonly targetOrigin: string;
}

/**
 * One window of the fake frames tree.
 *
 * It is an `EventTarget`, so the bus attaches its real listener to it, and the
 * test dispatches a real `MessageEvent`. `frames` is what the tree walk of the
 * coordinator reads.
 */
class FakeWindow extends EventTarget {
  readonly frames: FakeWindow[] = [];
  readonly posts: Post[] = [];

  postMessage(data: unknown, targetOrigin: string): void {
    this.posts.push({ data, targetOrigin });
  }
}

/** Every failure of a listener. A listener that fails is a defect of ours. */
interface World {
  readonly top: FakeWindow;
  readonly child: FakeWindow;
  readonly failures: string[];
}

const makeWorld = (): World => {
  const top = new FakeWindow();
  const child = new FakeWindow();
  top.frames.push(child);
  return { top, child, failures: [] };
};

/**
 * A `Dom` over the fake tree.
 *
 * `listen` and `listenOn` attach the handler exactly as the real service does:
 * with `addEventListener`, and with `runSyncExitWith`. A handler that suspends
 * therefore fails here, which is the property that the real listener needs.
 */
const domLayer = (world: World): Layer.Layer<Dom> =>
  Layer.effect(
    Dom,
    Effect.gen(function*() {
      const services = yield* Effect.context<never>();

      const attach = <A extends Event, R>(
        target: EventTarget,
        type: string,
        handler: Listener<A, R>,
      ): Effect.Effect<void, never, R | Scope.Scope> =>
        Effect.gen(function*() {
          const handlerServices = yield* Effect.context<R>();
          const run = Effect.runSyncExitWith(
            Context.merge(services, handlerServices),
          );
          const listen = (event: Event): void => {
            const exit = run(handler(event as A));
            if (Exit.isFailure(exit)) {
              world.failures.push(Cause.pretty(exit.cause));
            }
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
        });

      return Dom.of({
        window: world.top as unknown as Window & typeof globalThis,
        document: undefined as unknown as Document,
        href: Effect.succeed("https://top.example/"),
        probe: <A>(_api: string, read: () => A) => Effect.sync(read),
        probeOr: <A>(read: () => A, fallback: A) =>
          Effect.sync(() => {
            try {
              return read();
            } catch {
              return fallback;
            }
          }),
        attempt: <A>(_api: string, run: () => A) => Effect.sync(run),
        listen: <
          K extends keyof TargetEventMap,
          T extends keyof TargetEventMap[K],
          R,
        >(
          _target: K,
          type: T,
          handler: Listener<TargetEventMap[K][T], R>,
          _options?: ListenOptions,
        ) =>
          attach(
            world.top,
            String(type),
            handler as unknown as Listener<Event, R>,
          ),
        listenOn: <R>(
          target: EventTarget,
          type: string,
          handler: Listener<Event, R>,
        ) => attach(target, type, handler),
        events: <
          K extends keyof TargetEventMap,
          T extends keyof TargetEventMap[K],
        >() => Stream.empty as Stream.Stream<TargetEventMap[K][T]>,
        nextFrame: Effect.succeed(0),
        yieldToBrowser: Effect.void,
        now: Effect.sync(() => Date.now()),
      });
    }),
  );

// ---------------------------------------------------------------------------
// The frames of the page
// ---------------------------------------------------------------------------

/** The value store of the manager, as every frame of the page sees it. */
const makeStore = (): KeyValueStore["Service"] => {
  const map = new Map<string, string>();
  return KeyValueStore.of({
    kind: "gm-sync",
    durable: true,
    watchable: false,
    managerPrivate: true,
    get: (key) => Effect.sync(() => Option.fromNullishOr(map.get(key) ?? null)),
    set: (key, value) =>
      Effect.sync(() => {
        map.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        map.delete(key);
      }),
    changes: () => Stream.empty,
  });
};

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
 * One frame's `FrameAuth`, over the shared store.
 *
 * `Layer.fresh`, because a test builds two frames in one fiber and the layer of
 * a service is otherwise built once and shared.
 */
const authLayer = (
  kv: KeyValueStore["Service"],
  isTop: boolean,
  frameId: string,
): Layer.Layer<FrameAuth> =>
  Layer.fresh(FrameAuth.layer).pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(KeyValueStore, kv),
      realmLayer(isTop, frameId),
    )),
  );

/** The same service, with a delay on the proof of one attempt. */
const slowFor = (
  auth: FrameAuth["Service"],
  helloId: string,
): FrameAuth["Service"] =>
  FrameAuth.of({
    ...auth,
    verifyJoin: (handshake, proof) =>
      handshake.helloId === helloId
        ? Effect.andThen(
          Effect.sleep(SLOW_PROOF),
          auth.verifyJoin(handshake, proof),
        )
        : auth.verifyJoin(handshake, proof),
  });

// ---------------------------------------------------------------------------
// The child: what it sends, and what it reads
// ---------------------------------------------------------------------------

/** Send one message to the top window, as a child frame of the page does. */
const deliver = (
  world: World,
  data: unknown,
  ports: readonly MessagePort[],
): void => {
  const event = new MessageEvent("message", {
    data,
    origin: CHILD_ORIGIN,
    ports: [...ports],
  });
  // A `Window` is not constructible here, and the initialiser refuses any
  // other value. The coordinator compares the source with the frames tree, so
  // it must be the window object of the child.
  Object.defineProperty(event, "source", {
    value: world.child,
    configurable: true,
  });
  world.top.dispatchEvent(event);
};

/** Announce the child, and read the token of the challenge that comes back. */
const tokenOf = (world: World): string => {
  const before = world.child.posts.length;
  deliver(world, { ...ENVELOPE, kind: "HELLO" }, []);
  const post = world.child.posts[before];
  assert.isDefined(post, "the coordinator answered no challenge");
  assert.strictEqual(post?.targetOrigin, CHILD_ORIGIN);
  const data = post?.data as { readonly token?: unknown };
  assert.isString(data.token);
  return String(data.token);
};

const join = (
  world: World,
  handshake: FrameHandshake,
  proof: string,
  port: MessagePort,
): void =>
  deliver(world, {
    ...ENVELOPE,
    kind: "JOIN",
    token: handshake.token,
    helloId: handshake.helloId,
    frameId: handshake.frameId,
    proof,
  }, [port]);

/** The link of the child, over the port that the child still holds. */
const makeSealedLinkOf = (
  host: PortHost,
  port: MessagePort,
  cipher: FrameCipher,
  delivered: Queue.Queue<unknown>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.asVoid(
    makeSealedLink(host, port, cipher, "up", (data) =>
      Effect.sync(() => {
        Queue.offerUnsafe(delivered, data);
      })),
  );

/** Read one value, or give `None` after a wait on the real clock. */
const nextOf = <A>(queue: Queue.Queue<A>): Effect.Effect<Option.Option<A>> =>
  Effect.timeoutOrElse(Effect.map(Queue.take(queue), Option.some), {
    duration: "1 second",
    orElse: () => Effect.succeed(Option.none<A>()),
  });

/** Did a message of this kind reach the child on its own port? */
const sawKind = (
  delivered: Queue.Queue<unknown>,
  kind: string,
): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    while (true) {
      const next = yield* nextOf(delivered);
      if (Option.isNone(next)) return false;
      const message = next.value as { readonly kind?: unknown };
      if (message.kind === kind) return true;
    }
  });

describe("the admission of a JOIN", () => {
  it.live("admits the joins of one child in the order they arrive", () =>
    Effect.gen(function*() {
      const kv = makeStore();
      const world = makeWorld();
      const delivered = yield* Queue.unbounded<unknown>();

      // The top frame. Its `FrameAuth` creates the credential of the session.
      yield* Effect.gen(function*() {
        const real = yield* FrameAuth;
        const auth = slowFor(real, HELLO_FIRST);

        yield* Effect.gen(function*() {
          const bus = yield* FrameBus;
          const dom = yield* Dom;

          // Two announcements, so the child holds two live tokens.
          const first = { token: tokenOf(world) };
          const second = { token: tokenOf(world) };

          const handshakeOne: FrameHandshake = {
            token: first.token,
            helloId: HELLO_FIRST,
            frameId: CHILD_FRAME,
          };
          const handshakeTwo: FrameHandshake = {
            token: second.token,
            helloId: HELLO_SECOND,
            frameId: CHILD_FRAME,
          };

          // The child signs both attempts and keeps the cipher of the second.
          const signed = yield* Effect.gen(function*() {
            const child = yield* FrameAuth;
            return {
              one: yield* child.joinProof(handshakeOne),
              two: yield* child.joinProof(handshakeTwo),
              cipher: yield* child.cipher(handshakeTwo),
            };
          }).pipe(Effect.provide(authLayer(kv, false, CHILD_FRAME)));

          const one = new MessageChannel();
          const two = new MessageChannel();

          // Both joins arrive in one turn of the event loop, in this order.
          // The child closed the port of its first attempt when it opened the
          // second one, which is what `startAttempt` does.
          join(world, handshakeOne, signed.one, one.port2);
          one.port1.close();
          join(world, handshakeTwo, signed.two, two.port2);

          // The child reads the port of its second attempt, and no other.
          yield* makeSealedLinkOf(dom, two.port1, signed.cipher, delivered);

          // The proof of the first join takes longer than the second one.
          yield* Effect.sleep("500 millis");

          assert.isTrue(
            yield* sawKind(delivered, "WELCOME"),
            "the child was not welcomed on the port that it still holds",
          );

          // The link of the coordinator must be the port of the second
          // attempt. A message on the port of the first attempt reaches
          // nobody, because the child closed that port.
          const sent = yield* Effect.result(
            bus.send(toFrame(CHILD_FRAME as FrameId), {
              kind: "KEYSTROKE",
              notation: "a",
            }),
          );
          assert.isTrue(Result.isSuccess(sent), "the coordinator has no peer");

          assert.isTrue(
            yield* sawKind(delivered, "KEYSTROKE"),
            "the coordinator kept the port of the attempt that the child left",
          );
          assert.deepEqual(world.failures, []);
        }).pipe(
          Effect.provide(
            FrameBus.layer.pipe(
              Layer.provideMerge(Layer.mergeAll(
                domLayer(world),
                realmLayer(true, TOP_FRAME),
                Layer.succeed(FrameAuth, auth),
              )),
            ),
          ),
        );
      }).pipe(Effect.provide(authLayer(kv, true, TOP_FRAME)));
    }));

  it.live("keeps the newest join when page code fills the queue", () =>
    Effect.gen(function*() {
      const kv = makeStore();
      const world = makeWorld();
      const delivered = yield* Queue.unbounded<unknown>();

      yield* Effect.gen(function*() {
        const auth = yield* FrameAuth;

        yield* Effect.gen(function*() {
          const dom = yield* Dom;

          // The join of a true frame is signed first, because the signature
          // suspends. The flood must reach the queue in one turn.
          const handshake: FrameHandshake = {
            token: tokenOf(world),
            helloId: HELLO_SECOND,
            frameId: CHILD_FRAME,
          };
          const signed = yield* Effect.gen(function*() {
            const child = yield* FrameAuth;
            return {
              proof: yield* child.joinProof(handshake),
              cipher: yield* child.cipher(handshake),
            };
          }).pipe(Effect.provide(authLayer(kv, false, CHILD_FRAME)));

          // Page code holds the window of a `srcdoc` frame, so its joins are
          // joins of a known window. Each one takes a token and a port, and
          // each one carries a proof that it cannot make.
          const flood: MessageChannel[] = [];
          for (let index = 0; index <= MAX_PENDING_JOINS; index += 1) {
            const channel = new MessageChannel();
            flood.push(channel);
            join(
              world,
              {
                token: tokenOf(world),
                helloId: HELLO_FIRST,
                frameId: CHILD_FRAME,
              },
              "bm90LWEtcHJvb2Y",
              channel.port2,
            );
          }

          // The join of the true frame arrives last, on a full queue. No fiber
          // ran between the joins, so the queue holds the whole flood.
          const real = new MessageChannel();
          join(world, handshake, signed.proof, real.port2);

          yield* makeSealedLinkOf(dom, real.port1, signed.cipher, delivered);

          assert.isTrue(
            yield* sawKind(delivered, "WELCOME"),
            "the full queue dropped the newest join",
          );
          assert.deepEqual(world.failures, []);
        }).pipe(
          Effect.provide(
            FrameBus.layer.pipe(
              Layer.provideMerge(Layer.mergeAll(
                domLayer(world),
                realmLayer(true, TOP_FRAME),
                Layer.succeed(FrameAuth, auth),
              )),
            ),
          ),
        );
      }).pipe(Effect.provide(authLayer(kv, true, TOP_FRAME)));
    }));
});
