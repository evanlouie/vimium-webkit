/**
 * What happens once, when the application starts.
 *
 * Every step here is part of the layer graph, and not a script that somebody
 * calls. That is deliberate: each step acquires something, and the layer scope
 * is what releases it. There is no start function to keep in step with a stop
 * function.
 */

import { Context, Effect, Layer, Option, Stream } from "effect";
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
import { Lifecycle } from "./Lifecycle.ts";

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
          case "Persist": {
            // Marks wait 100 ms, settings 250 ms and the history index two
            // seconds. A navigation inside any of those windows used to lose
            // the write.
            yield* storage.flushAll;
            yield* keyboard.forgetSuppressed;
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
