/**
 * The application: one layer graph, and one runtime for one frame.
 *
 * Everything that this frame can do is here. A service asks for what it needs,
 * and this file is the only place that says where each thing comes from. There
 * is no god object, and no service reaches for a global.
 *
 * The runtime carries a `Scope`. Every listener, observer, port, stylesheet and
 * fiber that the graph acquires belongs to that scope. Closing it removes all of
 * them. Teardown is therefore correct by construction, and not correct because
 * somebody remembered to write it.
 *
 * The graph is built once, when the frame decides that the user wants us. Read
 * `src/boot/Guard.ts` for that decision.
 */

import { Layer, Logger, ManagedRuntime, References } from "effect";
import { Lifecycle } from "~/boot/Lifecycle.ts";
import { Commands } from "~/core/Commands.ts";
import { Exclusions } from "~/core/Exclusions.ts";
import { HandlerStack } from "~/core/HandlerStack.ts";
import { Keyboard } from "~/core/Keyboard.ts";
import { Mappings } from "~/core/Mappings.ts";
import { Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { FrameAuth } from "~/frames/Auth.ts";
import { FrameBus } from "~/frames/Bus.ts";
import { FrameLink } from "~/frames/Link.ts";
import { Find } from "~/features/find/Find.ts";
import { Hints } from "~/features/hints/Hints.ts";
import { Insert } from "~/features/Insert.ts";
import { Marks } from "~/features/Marks.ts";
import { Navigation } from "~/features/Navigation.ts";
import { Omnibar } from "~/features/omnibar/Omnibar.ts";
import { Scroller } from "~/features/Scroller.ts";
import { TabControl } from "~/features/TabControl.ts";
import { UrlClipboard } from "~/features/UrlClipboard.ts";
import { Visual } from "~/features/visual/Visual.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Clipboard } from "~/platform/Clipboard.ts";
import { Dom } from "~/platform/Dom.ts";
import { Gm } from "~/platform/Gm.ts";
import { KeyValueStore } from "~/platform/KeyValueStore.ts";
import { Realm } from "~/platform/Realm.ts";
import { Storage } from "~/platform/Storage.ts";
import { Tabs } from "~/platform/Tabs.ts";
import { Dialog } from "~/ui/Dialog.ts";
import { Hud } from "~/ui/Hud.ts";
import { Ui } from "~/ui/Ui.ts";

/**
 * Logging goes to the page console, at `Warn` and above.
 *
 * A userscript shares its console with the page that it is injected into.
 * Anything below a warning is noise in another person's developer tools.
 */
const Observability = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  Layer.succeed(References.MinimumLogLevel, "Warn"),
  /**
   * Tracing is off.
   *
   * `Effect.fn` names each span that it makes, which is worth having in the
   * code. Nothing exports a span here, and the span machinery costs about three
   * microseconds for each call. On the key path that is three microseconds for
   * each keystroke, for data that nobody reads.
   */
  Layer.succeed(References.TracerEnabled, false),
);

/** The browser and the userscript manager. */
const PlatformLayer = Layer.mergeAll(
  Realm.layer,
  Gm.layer,
  Lifecycle.layer,
).pipe(
  Layer.provideMerge(Dom.layer),
  Layer.provideMerge(Observability),
);

/** Storage, and the services that read it. */
const StorageLayer = Layer.mergeAll(
  Storage.layer.pipe(Layer.provideMerge(KeyValueStore.layer)),
  Capabilities.layer.pipe(Layer.provide(KeyValueStore.layer)),
  Clipboard.layer,
  Tabs.layer,
).pipe(Layer.provideMerge(PlatformLayer));

/** Settings, the key trie, modes and the command registry. */
const CoreLayer = Layer.mergeAll(
  Mappings.layer,
  Exclusions.layer,
  Modes.layer.pipe(Layer.provideMerge(HandlerStack.layer)),
  Commands.layer,
  Report.layer,
).pipe(
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(StorageLayer),
);

/**
 * The keyboard.
 *
 * It comes before the overlay, because the HUD draws the half-typed key
 * sequence and therefore reads `Keyboard.pending`. The keyboard itself reads
 * only the core, and never the overlay: it reports a failure through `Report`.
 */
const KeyboardLayer = Keyboard.layer.pipe(Layer.provideMerge(CoreLayer));

/** The overlay. */
const UiLayer = Layer.mergeAll(
  Hud.layer,
  Dialog.layer,
).pipe(
  Layer.provideMerge(Ui.layer),
  Layer.provideMerge(KeyboardLayer),
);

/** The cross-frame bus, and the protocol on top of it. */
const FramesLayer = FrameLink.layer.pipe(
  Layer.provideMerge(FrameBus.layer),
  Layer.provideMerge(FrameAuth.layer),
  Layer.provideMerge(UiLayer),
);

/**
 * The features.
 *
 * Each one writes its own command bodies into the registry when its layer is
 * built, and each one serves its own messages on the frame bus. No feature
 * imports another feature. A feature that needs what another feature does asks
 * the registry by name, with `Commands.run`.
 */
const FeatureLayer = Layer.mergeAll(
  Scroller.layer,
  Insert.layer,
  Marks.layer.pipe(Layer.provide(Scroller.layer)),
  Hints.layer,
  Find.layer,
  Visual.layer,
  Omnibar.layer,
  TabControl.layer,
  // `UrlClipboard` opens a URL that the user pasted, which is the same step
  // that `Navigation` takes for a typed URL. It asks for that service rather
  // than repeating the rule about what a bare word means.
  UrlClipboard.layer.pipe(Layer.provide(Navigation.layer)),
  Navigation.layer,
).pipe(Layer.provideMerge(FramesLayer));

/**
 * The whole application.
 *
 * A feature layer writes its command bodies into the registry when it is built,
 * and the keyboard reads that registry. The registry is one shared value, so
 * the order does not decide correctness. The order below is the order that a
 * reader expects.
 */
export const AppLayer = FeatureLayer;

export type AppServices = Layer.Success<typeof AppLayer>;

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

export const makeAppRuntime = (): AppRuntime => ManagedRuntime.make(AppLayer);
