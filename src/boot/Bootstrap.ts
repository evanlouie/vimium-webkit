/**
 * What happens once, when the application starts.
 *
 * Every step here is part of the layer graph, and not a script that somebody
 * calls. That is deliberate: each step acquires something, and the layer scope
 * is what releases it. There is no start function to keep in step with a stop
 * function.
 */

import {
  Array,
  Boolean,
  type Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  Scope,
  Stream,
  Struct,
  pipe,
} from "effect";
import { Commands } from "~/core/Commands.ts";
import { Exclusions, Verdict } from "~/core/Exclusions.ts";
import { Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { describeCause } from "~/domain/Failure.ts";
import { FrameBus } from "~/frames/Bus.ts";
import { Capabilities, degradationWarnings } from "~/platform/Capabilities.ts";
import { Dom } from "~/platform/Dom.ts";
import { FrameRole } from "~/platform/Realm.ts";
import { Storage, type StorageError } from "~/platform/Storage.ts";
import { Insert } from "~/features/Insert.ts";
import { Omnibar } from "~/features/omnibar/Omnibar.ts";
import { attachKeyBridge, replayBufferedKeys } from "./KeyBridge.ts";
import type { BootSignal } from "./Guard.ts";
import { type ExitHook, Lifecycle, LifecycleEvent, PageExit } from "./Lifecycle.ts";

/**
 * What the guard learned before the application existed.
 *
 * The guard is the only thing that saw the keys that arrived during the start,
 * and the only thing that knows whether the user was typing into a text field.
 */
export class Boot extends Context.Service<Boot, BootSignal>()("vimium/boot/Boot") {
  static readonly layerFrom = (signal: BootSignal): Layer.Layer<Boot> =>
    Layer.succeed(Boot, Boot.of(signal));
}

/**
 * Who owns the scope of this frame's application.
 *
 * The application cannot close its own scope from inside itself. `launch`
 * makes the scope, so `launch` gives this service. The application asks for
 * the release, and it never decides how the release happens.
 */
export class RuntimeOwner extends Context.Service<
  RuntimeOwner,
  {
    /** Release everything that this frame's application holds. */
    readonly release: Effect.Effect<void>;
  }
>()("vimium/boot/RuntimeOwner") {
  static readonly layerFrom = (release: Effect.Effect<void>): Layer.Layer<RuntimeOwner> =>
    Layer.succeed(RuntimeOwner, RuntimeOwner.of({ release }));
}

/** What the exit hook below needs. Named, so that a test can build it. */
export interface ExitParts {
  /** Write held values now when the selected backend is synchronous. */
  readonly flushAllUnsafe: () => void;
  /** Forget a key that was suppressed but never used. */
  readonly forgetSuppressed: Effect.Effect<void>;
  /** Write every value that is still inside its debounce window. */
  readonly flushAll: Effect.Effect<void>;
  /** Release everything that this frame's application holds. */
  readonly release: Effect.Effect<void>;
}

/**
 * What this frame does when the page goes away.
 *
 * The order is the order of the time budget. Read rule 1 in
 * `boot/Lifecycle.ts`: only the part before the first suspension is sure to
 * run, so the work that never suspends comes first.
 *
 * 1. Write held values directly when the backend is synchronous. This call
 *    takes no scheduler turn. Promise-backed managers do not use the debounce.
 * 2. Forget the suppressed key. It is in memory, and it costs nothing.
 * 3. Flush through the storage actor as well. The actor reports a failed write
 *    and settles waiting callers. It also takes commands from its mailbox.
 *    This part completes only when the page lives on.
 * 4. Release the application, but only on a final exit. A release closes the
 *    scope that the storage actor lives in. A release before the flush would
 *    drop the write that this hook exists to save. A page that comes back from
 *    the back/forward cache keeps its application. It never runs its scripts
 *    again, so nothing would build the application a second time.
 */
export const onPageExit = (parts: ExitParts): ExitHook =>
  Effect.fnUntraced(function* (exit: PageExit) {
    yield* Effect.sync(parts.flushAllUnsafe);
    yield* parts.forgetSuppressed;
    yield* parts.flushAll;
    yield* pipe(
      exit,
      PageExit.$match({
        Final: () => parts.release,
        Resumable: () => Effect.void,
      }),
    );
  });

/**
 * Say that the application failed to start.
 *
 * `console.error`, because the logger of the application is part of what
 * failed, and a userscript shares its console with the page. The console
 * therefore gets the text of the failure, and not the value itself.
 */
const reportStartFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.sync(() => {
    console.error("[vimium-webkit] failed to start", describeCause(cause));
  });

/**
 * Build the application in a scope of its own, and give it the release of that
 * scope.
 *
 * The release closes the scope, so every listener, port, stylesheet, manager
 * callback and fiber of the graph goes with it, and nothing of the graph runs
 * again. The application must therefore ask for the release only when this
 * document will not run again. A second release does nothing.
 *
 * A failure to start must never break the page. It is reported once, and the
 * part of the graph that was built before it is released: that part holds
 * listeners of the page, and nothing else knows about it.
 */
export const launch = (application: Layer.Layer<never, never, RuntimeOwner>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const release = Scope.close(scope, Exit.void);
    yield* pipe(
      application,
      Layer.provide(RuntimeOwner.layerFrom(release)),
      Layer.buildWithScope(scope),
      Effect.asVoid,
      Effect.catchCause((cause) => pipe(reportStartFailure(cause), Effect.andThen(release))),
    );
  });

/**
 * Say what a storage failure means to the user.
 *
 * The same reasons occur on a read and on a write, and the two need different
 * words. A failed read means that the defaults are now in use. A failed write
 * means that the change did not persist. One sentence for both said "could not
 * be read; using defaults" over a save that was refused.
 */
const describeStorageIssue = (issue: StorageError): string =>
  pipe(
    Match.value(issue.direction),
    Match.when(
      "write",
      () =>
        `Could not save ${issue.group}: ${issue.detail}. ` +
        "Your change applies to this tab only.",
    ),
    Match.when(
      "read",
      () =>
        `Stored ${issue.group} could not be read (${issue.reason}); ` +
        "using defaults. Open Settings to review.",
    ),
    Match.exhaustive,
  );

export const BootstrapLayer: Layer.Layer<
  never,
  never,
  | Boot
  | Capabilities
  | Commands
  | Dom
  | Exclusions
  | FrameBus
  | Insert
  | Lifecycle
  | Modes
  | Omnibar
  | Report
  | RuntimeOwner
  | Settings
  | Storage
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const boot = yield* Boot;
    const bus = yield* FrameBus;
    const capabilities = yield* Capabilities;
    const dom = yield* Dom;
    const exclusions = yield* Exclusions;
    const insert = yield* Insert;
    const omnibar = yield* Omnibar;
    const lifecycle = yield* Lifecycle;
    const modes = yield* Modes;
    const owner = yield* RuntimeOwner;
    const report = yield* Report;
    const settings = yield* Settings;
    const storage = yield* Storage;

    /** Work that only the top frame does. Its page is the page that the user visits. */
    const inTopFrame = (work: Effect.Effect<void>): Effect.Effect<void> =>
      pipe(
        bus.role,
        FrameRole.$match({
          Top: () => work,
          Child: () => Effect.void,
        }),
      );

    /**
     * Tell the user once about each loss that this manager or browser causes.
     *
     * The session group remembers each warning that the user saw. With no value
     * store it lasts as long as the page, so the warning comes once for each
     * page. The top frame alone speaks, so a page with frames speaks once. A
     * failed write is a storage issue of its own, and the user hears about it.
     */
    const warnOnce = Effect.gen(function* () {
      const { acknowledged } = yield* storage.session.current;
      const fresh = pipe(degradationWarnings(capabilities), Array.difference(acknowledged));
      yield* pipe(fresh, Effect.forEach(report.error, { discard: true }));
      yield* pipe(
        fresh,
        Array.match({
          onEmpty: () => Effect.void,
          onNonEmpty: (shown) =>
            pipe(
              storage.session.update(
                Struct.evolve({ acknowledged: (known) => pipe(known, Array.appendAll(shown)) }),
              ),
              Effect.ignore,
            ),
        }),
      );
    });

    /** Read the settings and the verdict again, after the page changed under us. */
    const refresh = Effect.gen(function* () {
      yield* settings.reload;
      yield* exclusions.refresh;
    });

    /**
     * Take the keyboard from the guard, and play the keys that it held once
     * the verdict is known.
     *
     * The guard lets go at once. A later key reaches normal mode, which gives
     * it to the page while the verdict is pending. Holding it instead would
     * take the keyboard from the page for as long as a child frame waits.
     *
     * The held keys are already taken from the page, so they wait. A child
     * frame learns the verdict from the top frame, and the handshake takes
     * time. A key that is played before then runs a command on a page that
     * the user may have excluded. A child frame that hears nothing before the
     * deadline only assumes a verdict, and it drops the keys instead: a guess
     * at the verdict is worse, and so is a key that acts seconds after the
     * user pressed it.
     */
    const replayHeldKeys = Effect.gen(function* () {
      const held = yield* boot.drain;
      yield* pipe(
        exclusions.settled,
        Effect.map(Verdict.$is("Known")),
        Effect.flatMap(
          Boolean.match({ onFalse: () => Effect.void, onTrue: () => replayBufferedKeys(held) }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
    });

    const wantsFocusBack = pipe(
      settings.current,
      Effect.map((current) => current.grabBackFocus),
    );

    /** Take the focus back from a page that took it on load, when the user asks for that. */
    const grabBackFocus = pipe(
      boot.typedIntoEditable,
      Effect.flatMap(insert.grabBackFocus),
      Effect.when(wantsFocusBack),
      Effect.asVoid,
    );

    /** What each change of the page means for this frame. */
    const onLifecycle = LifecycleEvent.$match({
      UrlChange: () =>
        Effect.gen(function* () {
          yield* modes.exitAll("navigation");
          yield* refresh;
          yield* inTopFrame(omnibar.noteVisit);
        }),
      Restore: () => refresh,
      // The portable substitute for a manager change listener, which quoid and
      // Stay do not have. Read shared storage again when the tab comes forward,
      // so that a settings change in another tab lands.
      Visible: () => Effect.asVoid(settings.reload),
      Leave: () => modes.exitAll("navigation"),
    });

    // Every storage failure becomes one line for the user. The queue behind
    // `Report` keeps the messages that happen before the HUD exists.
    yield* pipe(
      storage.issues,
      Stream.runForEach((issue) => report.error(describeStorageIssue(issue))),
      Effect.forkScoped,
    );

    // Every group, and never a subset. A group that was never read holds only the
    // defaults, and the first write to it would replace the user's whole stored
    // value with the defaults plus one change.
    yield* storage.hydrateAll;

    yield* inTopFrame(warnOnce);

    // The top frame matches the rules that it has just read. A child frame asked
    // the top frame when it started.
    yield* exclusions.refresh;

    // Before any listener is attached. Insert mode otherwise learns about focus
    // from live events only, and the page has long since focused its search box
    // by the time that the application starts.
    yield* insert.seedFromFocus;

    yield* inTopFrame(grabBackFocus);
    yield* inTopFrame(omnibar.noteVisit);

    // The key bridge comes before the drain, and the drain comes before the
    // guard scope closes. A key that arrives during the start is therefore
    // held by the guard or read by the bridge, and played at most once.
    yield* attachKeyBridge;
    yield* replayHeldKeys;

    // A hook, and not a subscription. The work that a page exit needs must start
    // inside the browser's dispatch. A subscriber of the bus below runs on its
    // own fiber, after the dispatch is over.
    yield* lifecycle.onExit(
      onPageExit({
        flushAllUnsafe: storage.flushAllUnsafe,
        forgetSuppressed: modes.forgetSuppressed,
        flushAll: storage.flushAll,
        release: owner.release,
      }),
    );

    yield* pipe(lifecycle.events, Stream.runForEach(onLifecycle), Effect.forkScoped);

    yield* Effect.logDebug(
      `vimium-webkit started in this frame (${boot.reason})`,
      dom.window.location.href,
    );
  }),
);
