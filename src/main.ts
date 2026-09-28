/**
 * The entry point.
 *
 * The whole application is one immediately-invoked function. A userscript
 * cannot split its code: a dynamic `import()` of a `blob:` or a `data:` URL is
 * exactly what a page's content security policy stops. "Lazy" here therefore
 * means lazily *run*, and not lazily fetched.
 *
 * This file runs in every frame of every page, and it does four things:
 *
 * 1. It claims the realm, so that a second injection does nothing.
 * 2. It waits until something says that the user wants us.
 * 3. It builds the application, and gives it the keyboard.
 * 4. It releases the application when this frame's page goes away for good.
 *
 * Step 2 is what keeps a page with twenty frames cheap. A frame that never
 * receives a key builds the guard, and nothing else.
 */

import {
  Cause,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  References,
  Schema,
  flow,
  pipe,
} from "effect";
import { AppLayer } from "~/App.ts";
import {
  Boot,
  BootstrapLayer,
  makeOwnedRuntime,
  type OwnedRuntime,
  type RuntimeOwner,
} from "~/boot/Bootstrap.ts";
import { awaitActivation, type BootSignal, claimRealm } from "~/boot/Guard.ts";
import { describeThrown } from "~/domain/Failure.ts";
import { Dom } from "~/platform/Dom.ts";
import { Realm } from "~/platform/Realm.ts";

/**
 * The runtime that the guard uses.
 *
 * It holds two services and nothing else. Building the whole graph here would
 * spend the cost in every frame, which is the one thing that this design
 * refuses to do.
 */
const GuardLayer = pipe(
  Layer.mergeAll(
    Realm.layer,
    Logger.layer([Logger.consolePrettyBrowser()]),
    Layer.succeed(References.MinimumLogLevel, "Warn"),
  ),
  Layer.provideMerge(Dom.layer),
);

/**
 * The application could not be built.
 *
 * A failure to start must never break the page. This error exists so that the
 * failure has a name in the error channel, and so that the one report below is
 * the only thing that happens next.
 */
class StartupFailed extends Schema.TaggedError<StartupFailed>()("StartupFailed", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The whole application for one activation, over the owner of its runtime. */
const applicationLayer =
  (signal: BootSignal) =>
  (owner: Layer.Layer<RuntimeOwner>): Layer.Layer<never> =>
    pipe(
      BootstrapLayer,
      Layer.provide(AppLayer),
      Layer.provide(Boot.layerFrom(signal)),
      Layer.provide(owner),
    );

/**
 * Build the application in its own runtime.
 *
 * A failure to start must never break the page. Report it once, and stay out
 * of the way. The guard's own listeners are harmless.
 */
const buildApplication = ({ runtime, release }: OwnedRuntime<never, never>): Effect.Effect<void> =>
  pipe(
    Effect.tryPromise({
      try: () => runtime.runPromise(Effect.void),
      catch: (cause) => new StartupFailed({ detail: describeThrown(cause), cause }),
    }),
    Effect.catchCause((cause) =>
      pipe(
        Effect.sync(() => {
          console.error("[vimium-webkit] failed to start", Cause.pretty(cause));
        }),
        // A part of the graph may have been built before the failure, and
        // that part holds listeners of this page. Nothing else will release
        // them, because nothing else knows about this runtime.
        Effect.andThen(release),
      ),
    ),
  );

/**
 * Wait until the user wants us, and then start.
 *
 * The guard scope stays open until the application has the keyboard. A key
 * that the user presses during the start therefore still reaches the buffer,
 * and `BootstrapLayer` plays it.
 */
const activate = Effect.gen(function* () {
  const signal = yield* awaitActivation;

  /**
   * The runtime of this frame, and the effect that closes it.
   *
   * The application asks for the release on a final page exit, and only
   * after the last writes reached storage. A page that goes into the
   * back/forward cache keeps its runtime. A restored page never runs its
   * scripts again, so nothing here would build a second one.
   *
   * This holder belongs to one realm. The script runs again in every frame,
   * so a child frame that goes away releases the runtime that the child
   * built. It cannot touch the runtime of any other frame.
   */
  const owned = makeOwnedRuntime(flow(applicationLayer(signal), ManagedRuntime.make));

  yield* buildApplication(owned);
});

const start = pipe(activate, Effect.scoped, Effect.when(claimRealm), Effect.asVoid);

pipe(start, Effect.provide(GuardLayer), Effect.runFork);
