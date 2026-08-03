/**
 * What happens once, when the application starts.
 *
 * Every step here is part of the layer graph, and not a script that somebody
 * calls. That is deliberate: each step acquires something, and the layer scope
 * is what releases it. There is no start function to keep in step with a stop
 * function.
 */

import {
  Context,
  Effect,
  Layer,
  type ManagedRuntime,
  Option,
  Stream,
} from "effect";
import { Commands } from "~/core/Commands.ts";
import { Exclusions } from "~/core/Exclusions.ts";
import { HandlerStack } from "~/core/HandlerStack.ts";
import { Keyboard } from "~/core/Keyboard.ts";
import { Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { FrameLink } from "~/frames/Link.ts";
import { Capabilities, degradationWarnings } from "~/platform/Capabilities.ts";
import { Dom } from "~/platform/Dom.ts";
import { Realm } from "~/platform/Realm.ts";
import { Storage, type StorageError } from "~/platform/Storage.ts";
import { Insert } from "~/features/Insert.ts";
import { Omnibar } from "~/features/omnibar/Omnibar.ts";
import { attachKeyBridge, replayBufferedKeys } from "./KeyBridge.ts";
import type { BootSignal } from "./Guard.ts";
import { type ExitHook, Lifecycle } from "./Lifecycle.ts";

/**
 * What the guard learned before the application existed.
 *
 * The guard is the only thing that saw the keys that arrived during the start,
 * and the only thing that knows whether the user was typing into a text field.
 */
export class Boot extends Context.Service<Boot, BootSignal>()(
  "vimium/boot/Boot",
) {
  static readonly layerFrom = (signal: BootSignal): Layer.Layer<Boot> =>
    Layer.succeed(Boot, Boot.of(signal));
}

/**
 * Who owns the runtime of this frame.
 *
 * A runtime cannot close its own scope from inside itself. `src/main.ts` builds
 * the runtime, so `src/main.ts` gives this service. The application asks for the
 * release, and it never decides how the release happens.
 */
export class RuntimeOwner extends Context.Service<RuntimeOwner, {
  /** Release everything that this frame's runtime holds. */
  readonly release: Effect.Effect<void>;
}>()("vimium/boot/RuntimeOwner") {
  static readonly layerFrom = (
    release: Effect.Effect<void>,
  ): Layer.Layer<RuntimeOwner> =>
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
  /** Release everything that this frame's runtime holds. */
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
 * 4. Release the runtime, but only on a final exit. A release closes the scope
 *    that the storage actor lives in. A release before the flush would drop the
 *    write that this hook exists to save. A page that comes back from the
 *    back/forward cache keeps its runtime. It never runs its scripts again, so
 *    nothing would build the runtime a second time.
 */
export const onPageExit = (parts: ExitParts): ExitHook => (exit) =>
  Effect.gen(function*() {
    yield* Effect.sync(() => parts.flushAllUnsafe());
    yield* parts.forgetSuppressed;
    yield* parts.flushAll;
    if (!exit.final) return;
    yield* parts.release;
  });

/** A runtime, and the one effect that closes it. */
export interface OwnedRuntime<R, ER> {
  readonly runtime: ManagedRuntime.ManagedRuntime<R, ER>;
  /** Close the runtime scope. It is safe to run it more than once. */
  readonly release: Effect.Effect<void>;
}

/**
 * Build a runtime that can ask to be released.
 *
 * The two needs make a circle: the layer needs a way to release the runtime,
 * and the runtime does not exist until the layer is built. The holder below
 * breaks the circle, because `Effect.suspend` reads it when the release runs.
 *
 * `dispose` closes the scope that the layer owns, so every listener, port,
 * stylesheet, manager callback and fiber goes with it. It also replaces the
 * context of the runtime with a defect. A runtime that was released cannot run
 * anything again. The caller must therefore ask for the release only when this
 * document will not run again.
 */
export const makeOwnedRuntime = <R, ER>(
  build: (
    owner: Layer.Layer<RuntimeOwner>,
  ) => ManagedRuntime.ManagedRuntime<R, ER>,
): OwnedRuntime<R, ER> => {
  let live: ManagedRuntime.ManagedRuntime<R, ER> | undefined;

  const release = Effect.suspend(() => {
    const current = live;
    live = undefined;
    if (current === undefined) return Effect.void;
    return Effect.promise(() =>
      current.dispose().catch((cause: unknown) => {
        console.error("[vimium-webkit] failed to release", cause);
      })
    );
  });

  const runtime = build(RuntimeOwner.layerFrom(release));
  live = runtime;
  return { runtime, release };
};

/**
 * Say what a storage failure means to the user.
 *
 * The same reasons occur on a read and on a write, and the two need different
 * words. A failed read means that the defaults are now in use. A failed write
 * means that the change did not persist. One sentence for both said "could not
 * be read; using defaults" over a save that was refused.
 */
const describeStorageIssue = (issue: StorageError): string =>
  issue.direction === "write"
    ? `Could not save ${issue.group}: ${issue.detail}. ` +
      "Your change applies to this tab only."
    : `Stored ${issue.group} could not be read (${issue.reason}); ` +
      "using defaults. Open Settings to review.";

export const BootstrapLayer: Layer.Layer<
  never,
  never,
  | Boot
  | Capabilities
  | Commands
  | Dom
  | Exclusions
  | FrameLink
  | HandlerStack
  | Insert
  | Keyboard
  | Lifecycle
  | Modes
  | Omnibar
  | Realm
  | Report
  | RuntimeOwner
  | Settings
  | Storage
> = Layer.effectDiscard(Effect.gen(function*() {
  const boot = yield* Boot;
  const capabilities = yield* Capabilities;
  const dom = yield* Dom;
  const exclusions = yield* Exclusions;
  const insert = yield* Insert;
  const omnibar = yield* Omnibar;
  const link = yield* FrameLink;
  const lifecycle = yield* Lifecycle;
  const modes = yield* Modes;
  const owner = yield* RuntimeOwner;
  const realm = yield* Realm;
  const report = yield* Report;
  const settings = yield* Settings;
  const keyboard = yield* Keyboard;
  const storage = yield* Storage;

  // Every storage failure becomes one line for the user. The queue behind
  // `Report` keeps the messages that happen before the HUD exists.
  yield* Effect.forkScoped(
    Stream.runForEach(
      storage.issues,
      (issue) => report.error(describeStorageIssue(issue)),
    ),
  );

  // Every group, and never a subset. A group that was never read holds only the
  // defaults, and the first write to it would replace the user's whole stored
  // value with the defaults plus one change.
  yield* storage.hydrateAll;

  for (const warning of degradationWarnings(capabilities)) {
    yield* report.error(warning);
  }

  /**
   * Work out the verdict for this frame.
   *
   * The top frame reads its own URL. A child frame cannot read the top frame's
   * URL across origins, so it asks. Upstream Vimium matches on the top frame's
   * URL as well: without that, an excluded page would still have us live inside
   * its third-party frames.
   */
  const resolveExclusion = Effect.gen(function*() {
    if (realm.isTop) {
      yield* exclusions.adopt(yield* exclusions.resolveLocal);
      return;
    }
    const remote = yield* Effect.option(link.effectiveExclusion);
    if (Option.isSome(remote)) yield* exclusions.adopt(remote.value);
  });

  yield* resolveExclusion;
  yield* keyboard.syncExclusion;

  // The key bridge comes before the replay, and the replay comes before the
  // guard scope closes. A key that arrives during the start is therefore held,
  // and then played, exactly once.
  // Before any listener is attached. Insert mode otherwise learns about focus
  // from live events only, and the page has long since focused its search box
  // by the time that the application starts.
  yield* insert.seedFromFocus;
  yield* insert.ensureEntered;

  const settingsNow = yield* settings.current;
  if (settingsNow.grabBackFocus && realm.isTop) {
    yield* insert.grabBackFocus(yield* boot.typedIntoEditable);
  }
  if (realm.isTop) yield* omnibar.noteVisit;

  yield* attachKeyBridge;
  yield* replayBufferedKeys(yield* boot.drain);

  // A hook, and not a subscription. The work that a page exit needs must start
  // inside the browser's dispatch. A subscriber of the bus below runs on its
  // own fiber, after the dispatch is over.
  yield* lifecycle.onExit(onPageExit({
    flushAllUnsafe: storage.flushAllUnsafe,
    forgetSuppressed: keyboard.forgetSuppressed,
    flushAll: storage.flushAll,
    release: owner.release,
  }));

  yield* Effect.forkScoped(
    Stream.runForEach(lifecycle.events, (event) =>
      Effect.gen(function*() {
        switch (event._tag) {
          case "UrlChange": {
            yield* modes.exitAll("navigation");
            yield* settings.reload;
            yield* resolveExclusion;
            yield* keyboard.syncExclusion;
            yield* insert.ensureEntered;
            if (realm.isTop) yield* omnibar.noteVisit;
            return;
          }
          case "Restore": {
            yield* settings.reload;
            yield* resolveExclusion;
            yield* keyboard.syncExclusion;
            yield* insert.ensureEntered;
            return;
          }
          case "Visible": {
            // The portable substitute for a manager change listener, which
            // quoid and Stay do not have. Read shared storage again when the
            // tab comes forward, so that a settings change in another tab
            // lands.
            yield* settings.reload;
            return;
          }
          case "Leave": {
            yield* modes.exitAll("navigation");
            return;
          }
        }
      })),
  );

  yield* Effect.logDebug(
    `vimium-webkit started in this frame (${boot.reason})`,
    dom.window.location.href,
  );
}));
