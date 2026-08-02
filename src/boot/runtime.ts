/**
 * The frame's Effect runtime.
 *
 * One `ManagedRuntime` per frame, built inside Stage 1 and never at module
 * scope: a userscript is evaluated at `document-start` in every frame of every
 * page, and building a runtime at import time would spend that cost in frames
 * that never see a keystroke. `test/unit/module-graph_test.ts` enforces the
 * rule — every module must import cleanly, doing no work.
 *
 * The runtime carries a `Scope`. Everything acquired through it — listeners,
 * observers, ports, stylesheets — is released by closing that scope, which is
 * what makes teardown correct by construction rather than by remembering.
 */

import { Effect, Layer, Logger, ManagedRuntime, References } from "effect";
import { Clipboard } from "~/platform/clipboard.ts";
import { Gm, type GmSurface } from "~/platform/gm.ts";
import { Tabs } from "~/platform/tabs.ts";

/**
 * Logging goes to the page console, at `Warn` and above.
 *
 * A userscript shares its console with the page it is injected into. Anything
 * chattier than a warning is noise in somebody else's devtools.
 */
const LoggingLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  Layer.succeed(References.MinimumLogLevel, "Warn"),
);

/**
 * Tracing is off.
 *
 * `Effect.fn` names every span it creates, which is worth having in the code,
 * but nothing exports them here and the span machinery costs about 3 µs per
 * call. On the key path that is 3 µs per keystroke for data nobody reads.
 */
const TracingLayer = Layer.succeed(References.TracerEnabled, false);

/**
 * Everything the frame's effects can ask for.
 *
 * `Gm` is provided from the surface Stage 1 has already probed rather than
 * detected again: probing reads ambient globals in a realm a page can tamper
 * with, and doing it twice invites the two answers to disagree.
 */
export const appLayer = (surface: GmSurface): Layer.Layer<AppServices> =>
  Layer.mergeAll(
    Clipboard.layer,
    Tabs.layer,
  ).pipe(
    // `mergeAll` builds its inputs in parallel. Supply `Gm` outside that
    // parallel group because both service layers require it.
    Layer.provideMerge(Gm.layerFrom(surface)),
    Layer.provideMerge(Layer.mergeAll(LoggingLayer, TracingLayer)),
  );

export type AppServices = Gm | Clipboard | Tabs;

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

export const makeAppRuntime = (surface: GmSurface): AppRuntime =>
  ManagedRuntime.make(appLayer(surface));

/**
 * Run an effect that must not fail, reporting a defect rather than throwing.
 *
 * Used at the DOM boundary, where there is no caller to hand a failure to: a
 * throw inside a listener is swallowed by the browser, so the alternative to
 * this is silence.
 */
export const runDetached = (
  runtime: AppRuntime,
  effect: Effect.Effect<unknown, never, never>,
): void => {
  runtime.runFork(effect);
};
