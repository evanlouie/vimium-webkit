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

import { Effect, Layer, Logger, References, pipe } from "effect";
import { AppLayer } from "~/App.ts";
import { Boot, BootstrapLayer, launch } from "~/boot/Bootstrap.ts";
import { awaitActivation, claimRealm } from "~/boot/Guard.ts";
import { Dom } from "~/platform/Dom.ts";
import { Realm } from "~/platform/Realm.ts";

/**
 * The services that the guard uses.
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
 * Wait until the user wants us, and then start.
 *
 * The guard scope stays open until the application has the keyboard. A key
 * that the user presses during the start therefore still reaches the buffer,
 * and `BootstrapLayer` plays it.
 *
 * The application lives in a scope of its own, and not in the guard scope. It
 * asks for the release on a final page exit, and only after the last writes
 * reached storage. A page that goes into the back/forward cache keeps it. A
 * restored page never runs its scripts again, so nothing here would build a
 * second one. The script runs again in every frame, so a child frame that goes
 * away releases the application that the child built, and nothing else.
 */
const activate = Effect.gen(function* () {
  const signal = yield* awaitActivation;
  yield* pipe(
    BootstrapLayer,
    Layer.provide(AppLayer),
    Layer.provide(Boot.layerFrom(signal)),
    launch,
  );
});

const start = pipe(activate, Effect.scoped, Effect.when(claimRealm), Effect.asVoid);

pipe(start, Effect.provide(GuardLayer), Effect.runFork);
