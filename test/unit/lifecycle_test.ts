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
import { Effect, Exit, Layer, Ref, Scope } from "effect";
import { type ExitHook, Lifecycle, type PageExit } from "~/boot/Lifecycle.ts";
import { Dom } from "~/platform/Dom.ts";

// ---------------------------------------------------------------------------
// The stubs
// ---------------------------------------------------------------------------

interface Attached {
  readonly type: string;
  readonly run: (event: Event) => Effect.Effect<void>;
}

interface FakeDocument {
  visibilityState: "visible" | "hidden";
}

/** `Dom`, with `listen` recording, and with a document that a test can hide. */
const recordingDom = (
  attached: Ref.Ref<ReadonlyArray<Attached>>,
  document: FakeDocument,
): Layer.Layer<Dom> =>
  Layer.effect(
    Dom,
    Effect.map(Dom, (dom) =>
      Dom.of({
        ...dom,
        document: document as unknown as Document,
        href: Effect.succeed("https://example.test/one"),
        // The cast says what the stub already is: every listener of the
        // lifecycle needs no service, so a recorded body is an `Effect<void>`.
        listen: ((
          _target: unknown,
          type: unknown,
          handler: (event: Event) => Effect.Effect<void>,
        ) =>
          Ref.update(attached, (current) => [
            ...current,
            { type: String(type), run: handler },
          ])) as unknown as Dom["Service"]["listen"],
      })),
  ).pipe(Layer.provide(Dom.layer));

/** A `pagehide` event, with the one field that the code reads. */
const pageHide = (persisted: boolean): Event =>
  ({ type: "pagehide", persisted }) as unknown as Event;

const visibilityChange = (): Event =>
  ({ type: "visibilitychange" }) as unknown as Event;

/**
 * Dispatch an event exactly as the browser does.
 *
 * `platform/Dom.ts` runs a listener with `runSyncExitWith`, so the whole
 * listener happens inside the dispatch. A listener that suspends gives a defect
 * here, and that defect is one of the failures that these tests must see.
 */
const dispatch = (
  attached: ReadonlyArray<Attached>,
  type: string,
  event: Event,
): Effect.Effect<Exit.Exit<void>> =>
  Effect.sync(() => {
    const outcomes = attached
      .filter((entry) => entry.type === type)
      .map((entry) => Effect.runSyncExit(entry.run(event)));
    return outcomes.find(Exit.isFailure) ?? Exit.void;
  });

/**
 * Dispatch an event without the drain that `runSyncExit` does.
 *
 * `runSyncExit` uses a scheduler that it flushes before it returns, so it hides
 * where a hook started. `runFork` uses the ordinary scheduler, which is a
 * macrotask. What ran when this returns is what ran on the caller's own stack.
 */
const dispatchOnStack = (
  attached: ReadonlyArray<Attached>,
  type: string,
  event: Event,
): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const entry of attached.filter((other) => other.type === type)) {
      Effect.runFork(entry.run(event));
    }
  });

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
  Effect.gen(function*() {
    const attached = yield* Ref.make<ReadonlyArray<Attached>>([]);
    const document: FakeDocument = { visibilityState: "visible" };

    yield* Effect.provide(
      Effect.scoped(Effect.gen(function*() {
        const lifecycle = yield* Lifecycle;
        yield* body({
          attached: yield* Ref.get(attached),
          lifecycle,
          document,
        });
      })),
      Lifecycle.layer.pipe(Layer.provide(recordingDom(attached, document))),
    );
  });

/** A hook that records the exit that it received. */
const record = (started: PageExit[]): ExitHook => (exit) =>
  Effect.sync(() => {
    started.push(exit);
  });

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe("the pagehide dispatch", () => {
  it.effect(
    "runs a hook that cannot suspend inside the dispatch",
    () =>
      withLifecycle(({ attached, lifecycle }) =>
        Effect.gen(function*() {
          // What the hook does is a plain synchronous step, which is what the
          // exit path of storage is. `test/unit/exit-write_test.ts` drives the
          // real `Storage` over a real backend.
          const written: string[] = [];
          const pending = "the mark that the user just set";

          yield* lifecycle.onExit(() =>
            Effect.sync(() => {
              written.push(pending);
            })
          );

          const outcome = yield* dispatch(
            attached,
            "pagehide",
            pageHide(false),
          );

          // Both assertions matter. The work happened, and the listener did
          // not become a defect on the way to it.
          assert.deepStrictEqual(
            written,
            [pending],
            "the work must start inside the dispatch",
          );
          assert.isTrue(
            Exit.isSuccess(outcome),
            "the pagehide listener must not fail",
          );
        })
      ),
  );

  it.effect(
    "starts a hook on the caller's stack, and not on a scheduler turn",
    () =>
      withLifecycle(({ attached, lifecycle }) =>
        Effect.gen(function*() {
          // The fork uses `startImmediately`, so the hook runs before the fork
          // returns. Without it the hook waits for a task of the scheduler,
          // and in a page that task is `setTimeout(f, 0)`. A `pagehide`
          // handler never sees one.
          const written: string[] = [];
          yield* lifecycle.onExit(() =>
            Effect.sync(() => {
              written.push("the held value");
            })
          );

          yield* dispatchOnStack(attached, "pagehide", pageHide(false));

          assert.deepStrictEqual(
            written,
            ["the held value"],
            "the hook must not wait for the scheduler",
          );
        })
      ),
  );

  it.effect(
    "starts every hook, in the order that they were registered",
    () =>
      withLifecycle(({ attached, lifecycle }) =>
        Effect.gen(function*() {
          const order: string[] = [];
          yield* lifecycle.onExit(() =>
            Effect.sync(() => {
              order.push("first");
            })
          );
          yield* lifecycle.onExit(() =>
            Effect.sync(() => {
              order.push("second");
            })
          );

          yield* dispatch(attached, "pagehide", pageHide(false));

          assert.deepStrictEqual(order, ["first", "second"]);
        })
      ),
  );

  it.effect(
    "keeps going when one hook fails",
    () =>
      withLifecycle(({ attached, lifecycle }) =>
        Effect.gen(function*() {
          const written: string[] = [];
          yield* lifecycle.onExit(() => Effect.die("a broken hook"));
          yield* lifecycle.onExit(() =>
            Effect.sync(() => {
              written.push("the good hook");
            })
          );

          const outcome = yield* dispatch(
            attached,
            "pagehide",
            pageHide(false),
          );

          assert.deepStrictEqual(written, ["the good hook"]);
          assert.isTrue(Exit.isSuccess(outcome));
        })
      ),
  );
});

describe("what an exit means", () => {
  it.effect(
    "a page that will not come back is a final exit",
    () =>
      withLifecycle(({ attached, lifecycle }) =>
        Effect.gen(function*() {
          const started: PageExit[] = [];
          yield* lifecycle.onExit(record(started));

          yield* dispatch(attached, "pagehide", pageHide(false));

          assert.deepStrictEqual(started, [{ final: true }]);
        })
      ),
  );

  it.effect(
    "a page that the browser keeps is not a final exit",
    () =>
      withLifecycle(({ attached, lifecycle }) =>
        Effect.gen(function*() {
          const started: PageExit[] = [];
          yield* lifecycle.onExit(record(started));

          // `persisted === true`: the page may come back from the
          // back/forward cache, and it never runs its scripts again.
          yield* dispatch(attached, "pagehide", pageHide(true));

          assert.deepStrictEqual(started, [{ final: false }]);
        })
      ),
  );

  it.effect(
    "a tab that goes to the background starts the same work",
    () =>
      withLifecycle(({ attached, lifecycle, document }) =>
        Effect.gen(function*() {
          const started: PageExit[] = [];
          yield* lifecycle.onExit(record(started));

          // The last moment that mobile WebKit reliably gives us.
          document.visibilityState = "hidden";
          const outcome = yield* dispatch(
            attached,
            "visibilitychange",
            visibilityChange(),
          );

          assert.deepStrictEqual(started, [{ final: false }]);
          assert.isTrue(Exit.isSuccess(outcome));
        })
      ),
  );

  it.effect(
    "a tab that comes forward starts nothing",
    () =>
      withLifecycle(({ attached, lifecycle, document }) =>
        Effect.gen(function*() {
          const started: PageExit[] = [];
          yield* lifecycle.onExit(record(started));

          document.visibilityState = "visible";
          yield* dispatch(attached, "visibilitychange", visibilityChange());

          assert.deepStrictEqual(started, []);
        })
      ),
  );
});

describe("the life of a hook", () => {
  it.effect(
    "a hook goes when its own scope closes",
    () =>
      withLifecycle(({ attached, lifecycle }) =>
        Effect.gen(function*() {
          const started: PageExit[] = [];
          const scope = yield* Scope.make();
          yield* Scope.provide(lifecycle.onExit(record(started)), scope);
          yield* Scope.close(scope, Exit.void);

          yield* dispatch(attached, "pagehide", pageHide(false));

          assert.deepStrictEqual(started, []);
        })
      ),
  );

  it.effect(
    "one scope that closes leaves the other registration of the same hook",
    () =>
      withLifecycle(({ attached, lifecycle }) =>
        Effect.gen(function*() {
          // Two features may register the same function. A removal by the
          // function reference would take both away.
          const started: PageExit[] = [];
          const shared = record(started);

          const first = yield* Scope.make();
          const second = yield* Scope.make();
          yield* Scope.provide(lifecycle.onExit(shared), first);
          yield* Scope.provide(lifecycle.onExit(shared), second);
          yield* Scope.close(first, Exit.void);

          yield* dispatch(attached, "pagehide", pageHide(false));

          assert.deepStrictEqual(
            started,
            [{ final: true }],
            "the registration that is still open must run, and only once",
          );
          yield* Scope.close(second, Exit.void);
        })
      ),
  );
});
