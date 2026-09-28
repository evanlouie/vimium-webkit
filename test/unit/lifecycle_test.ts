/**
 * The page lifecycle, at the moment that the page goes away.
 *
 * The browser gives one synchronous run, and it promises no other. The test
 * therefore does what the browser does: it takes the listener that the layer
 * registered, and it runs that listener with `runSyncExit`. What the recorder
 * holds when the run returns is the work that a true page exit would have
 * started. Everything after that is work that a dying page can lose.
 *
 * `Dom` is a stub that records each listener, so no test here needs a window.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, type Context, Effect, Exit, Layer, Option, Ref, Scope, Struct, pipe } from "effect";
import { type ExitHook, Lifecycle, PageExit } from "~/boot/Lifecycle.ts";
import { Dom, type Listener, type TargetEventMap } from "~/platform/Dom.ts";

// ---------------------------------------------------------------------------
// The stubs
// ---------------------------------------------------------------------------

/**
 * The events of one dispatch, by target and by type.
 *
 * A recorded listener takes the event for its own target and type, so each
 * listener gets the kind of event that it asked for.
 */
type Dispatch = {
  readonly [K in keyof TargetEventMap]?: {
    readonly [T in keyof TargetEventMap[K]]?: TargetEventMap[K][T];
  };
};

/** A recorded listener. It gives the work to run when a dispatch has an event for it. */
type Attached = (events: Dispatch) => Option.Option<Effect.Effect<void>>;

/** The event of one target and type in a dispatch. */
const eventFor = <K extends keyof TargetEventMap, T extends keyof TargetEventMap[K]>(
  events: Dispatch,
  target: K,
  type: T,
): Option.Option<TargetEventMap[K][T]> =>
  pipe(
    Option.fromNullishOr(events[target]),
    Option.flatMap((byType) => Option.fromNullishOr(byType[type])),
  );

/**
 * `Dom.listen`, recording each listener instead of touching a window.
 *
 * A recorded listener keeps the services of its caller, as the real one does.
 */
const recordingListen =
  (attached: Ref.Ref<ReadonlyArray<Attached>>): Dom["Service"]["listen"] =>
  <K extends keyof TargetEventMap, T extends keyof TargetEventMap[K], R>(
    target: K,
    type: T,
    handler: Listener<TargetEventMap[K][T], R>,
  ): Effect.Effect<void, never, R> => {
    const listener =
      (services: Context.Context<R>): Attached =>
      (events) =>
        pipe(
          eventFor(events, target, type),
          Option.map((event) => pipe(handler(event), Effect.provideContext(services))),
        );
    return pipe(
      Effect.context<R>(),
      Effect.flatMap((services) =>
        pipe(attached, Ref.update<ReadonlyArray<Attached>>(Array.append(listener(services)))),
      ),
    );
  };

/** The one field of the document that the lifecycle reads. */
interface FakeDocument {
  visibilityState: DocumentVisibilityState;
}

/** `Dom`, with `listen` recording, and with a document that a test can hide. */
const recordingDom = (
  attached: Ref.Ref<ReadonlyArray<Attached>>,
  document: FakeDocument,
): Layer.Layer<Dom> =>
  pipe(
    Dom,
    Effect.map(
      Struct.assign({
        // Node has no `Document`, and a whole one is hundreds of members. The
        // lifecycle reads `visibilityState` and nothing else, so the stub says
        // that it is a document. This is the one assertion in the file.
        document: document as Document,
        href: Effect.succeed("https://example.test/one"),
        listen: recordingListen(attached),
      }),
    ),
    Layer.effect(Dom),
    Layer.provide(Dom.layer),
  );

/** A `pagehide` or a `pageshow`, with the one field that the lifecycle reads. */
class PageTransition extends Event implements PageTransitionEvent {
  constructor(
    type: "pagehide" | "pageshow",
    readonly persisted: boolean,
  ) {
    super(type);
  }
}

const pageHide = (persisted: boolean): Dispatch => ({
  window: { pagehide: new PageTransition("pagehide", persisted) },
});

const visibilityChange = (): Dispatch => ({
  document: { visibilitychange: new Event("visibilitychange") },
});

/** The work of every listener that has an event in this dispatch, in the order of registration. */
const listenersFor = (
  attached: ReadonlyArray<Attached>,
  events: Dispatch,
): ReadonlyArray<Effect.Effect<void>> =>
  pipe(
    attached,
    Array.map((listener) => listener(events)),
    Array.getSomes,
  );

/**
 * Dispatch an event exactly as the browser does.
 *
 * `platform/Dom.ts` runs a listener with `runSyncExitWith`, so the whole
 * listener happens inside the dispatch. A listener that suspends gives a defect
 * here, and that defect is one of the failures that these tests must see.
 */
const dispatch = (
  attached: ReadonlyArray<Attached>,
  events: Dispatch,
): Effect.Effect<Exit.Exit<void>> =>
  Effect.sync(() =>
    pipe(
      listenersFor(attached, events),
      Array.map((work) => Effect.runSyncExit(work)),
      Array.findFirst(Exit.isFailure),
      Option.getOrElse(() => Exit.void),
    ),
  );

/**
 * Dispatch an event without the drain that `runSyncExit` does.
 *
 * `runSyncExit` uses a scheduler that it flushes before it returns, so it hides
 * where a hook started. `runFork` uses the ordinary scheduler, which is a
 * macrotask. What ran when this returns is what ran on the caller's own stack.
 */
const dispatchOnStack = (
  attached: ReadonlyArray<Attached>,
  events: Dispatch,
): Effect.Effect<void> =>
  Effect.sync(() =>
    pipe(
      listenersFor(attached, events),
      Array.forEach((work) => {
        Effect.runFork(work);
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

interface Harness {
  /** Every listener that the layer registered. */
  readonly attached: ReadonlyArray<Attached>;
  readonly lifecycle: Lifecycle["Service"];
  /** Change `visibilityState` before a `visibilitychange`. */
  readonly document: FakeDocument;
}

/** Build the lifecycle over the stub, and give the body a live scope. */
const withLifecycle = (
  body: (harness: Harness) => Effect.Effect<void, never, Scope.Scope>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const attached = yield* Ref.make<ReadonlyArray<Attached>>([]);
    const document: FakeDocument = { visibilityState: "visible" };
    const layer = pipe(Lifecycle.layer, Layer.provide(recordingDom(attached, document)));

    const run = Effect.gen(function* () {
      const lifecycle = yield* Lifecycle;
      const listeners = yield* Ref.get(attached);
      yield* body({ attached: listeners, lifecycle, document });
    });

    yield* pipe(run, Effect.scoped, Effect.provide(layer));
  });

/** A hook that records the exit that it received. */
const record =
  (started: PageExit[]): ExitHook =>
  (exit) =>
    Effect.sync(() => {
      started.push(exit);
    });

/** A hook that writes one value, as the exit path of storage does. */
const writing =
  (written: string[], value: string): ExitHook =>
  () =>
    Effect.sync(() => {
      written.push(value);
    });

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe("the pagehide dispatch", () => {
  it.effect("runs a hook that cannot suspend inside the dispatch", () =>
    withLifecycle(({ attached, lifecycle }) =>
      Effect.gen(function* () {
        // What the hook does is a plain synchronous step, which is what the
        // exit path of storage is.
        const written: string[] = [];
        const pending = "the mark that the user just set";

        yield* lifecycle.onExit(writing(written, pending));

        const outcome = yield* dispatch(attached, pageHide(false));

        // Both assertions matter. The work happened, and the listener did
        // not become a defect on the way to it.
        assert.deepStrictEqual(written, [pending], "the work must start inside the dispatch");
        assert.isTrue(Exit.isSuccess(outcome), "the pagehide listener must not fail");
      }),
    ),
  );

  it.effect("starts a hook on the caller's stack, and not on a scheduler turn", () =>
    withLifecycle(({ attached, lifecycle }) =>
      Effect.gen(function* () {
        // The fork uses `startImmediately`, so the hook runs before the fork
        // returns. Without it the hook waits for a task of the scheduler,
        // and in a page that task is `setTimeout(f, 0)`. A `pagehide`
        // handler never sees one.
        const written: string[] = [];
        yield* lifecycle.onExit(writing(written, "the held value"));

        yield* dispatchOnStack(attached, pageHide(false));

        assert.deepStrictEqual(
          written,
          ["the held value"],
          "the hook must not wait for the scheduler",
        );
      }),
    ),
  );

  it.effect("starts every hook, in the order that they were registered", () =>
    withLifecycle(({ attached, lifecycle }) =>
      Effect.gen(function* () {
        const order: string[] = [];
        yield* lifecycle.onExit(writing(order, "first"));
        yield* lifecycle.onExit(writing(order, "second"));

        yield* dispatch(attached, pageHide(false));

        assert.deepStrictEqual(order, ["first", "second"]);
      }),
    ),
  );

  it.effect("keeps going when one hook fails", () =>
    withLifecycle(({ attached, lifecycle }) =>
      Effect.gen(function* () {
        const written: string[] = [];
        yield* lifecycle.onExit(() => Effect.die("a broken hook"));
        yield* lifecycle.onExit(writing(written, "the good hook"));

        const outcome = yield* dispatch(attached, pageHide(false));

        assert.deepStrictEqual(written, ["the good hook"]);
        assert.isTrue(Exit.isSuccess(outcome));
      }),
    ),
  );
});

describe("what an exit means", () => {
  it.effect("a page that will not come back is a final exit", () =>
    withLifecycle(({ attached, lifecycle }) =>
      Effect.gen(function* () {
        const started: PageExit[] = [];
        yield* lifecycle.onExit(record(started));

        yield* dispatch(attached, pageHide(false));

        assert.deepStrictEqual(started, [PageExit.Final()]);
      }),
    ),
  );

  it.effect("a page that the browser keeps is not a final exit", () =>
    withLifecycle(({ attached, lifecycle }) =>
      Effect.gen(function* () {
        const started: PageExit[] = [];
        yield* lifecycle.onExit(record(started));

        // `persisted === true`: the page may come back from the
        // back/forward cache, and it never runs its scripts again.
        yield* dispatch(attached, pageHide(true));

        assert.deepStrictEqual(started, [PageExit.Resumable()]);
      }),
    ),
  );

  it.effect("a tab that goes to the background starts the same work", () =>
    withLifecycle(({ attached, lifecycle, document }) =>
      Effect.gen(function* () {
        const started: PageExit[] = [];
        yield* lifecycle.onExit(record(started));

        // The last moment that mobile WebKit reliably gives us.
        document.visibilityState = "hidden";
        const outcome = yield* dispatch(attached, visibilityChange());

        assert.deepStrictEqual(started, [PageExit.Resumable()]);
        assert.isTrue(Exit.isSuccess(outcome));
      }),
    ),
  );

  it.effect("a tab that comes forward starts nothing", () =>
    withLifecycle(({ attached, lifecycle, document }) =>
      Effect.gen(function* () {
        const started: PageExit[] = [];
        yield* lifecycle.onExit(record(started));

        document.visibilityState = "visible";
        yield* dispatch(attached, visibilityChange());

        assert.deepStrictEqual(started, []);
      }),
    ),
  );
});

describe("the life of a hook", () => {
  it.effect("a hook goes when its own scope closes", () =>
    withLifecycle(({ attached, lifecycle }) =>
      Effect.gen(function* () {
        const started: PageExit[] = [];
        const scope = yield* Scope.make();
        yield* pipe(lifecycle.onExit(record(started)), Scope.provide(scope));
        yield* Scope.close(scope, Exit.void);

        yield* dispatch(attached, pageHide(false));

        assert.deepStrictEqual(started, []);
      }),
    ),
  );

  it.effect("one scope that closes leaves the other registration of the same hook", () =>
    withLifecycle(({ attached, lifecycle }) =>
      Effect.gen(function* () {
        // Two features may register the same function. A removal by the
        // function reference would take both away.
        const started: PageExit[] = [];
        const shared = record(started);

        const first = yield* Scope.make();
        const second = yield* Scope.make();
        yield* pipe(lifecycle.onExit(shared), Scope.provide(first));
        yield* pipe(lifecycle.onExit(shared), Scope.provide(second));
        yield* Scope.close(first, Exit.void);

        yield* dispatch(attached, pageHide(false));

        assert.deepStrictEqual(
          started,
          [PageExit.Final()],
          "the registration that is still open must run, and only once",
        );
        yield* Scope.close(second, Exit.void);
      }),
    ),
  );
});
