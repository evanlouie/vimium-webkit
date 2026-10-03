/**
 * Copying the URL of this page, and opening a URL that the user pasted.
 *
 * The write path is activation-sensitive. WebKit spends the transient user
 * activation on the first suspension, so the clipboard write must be reached
 * from the key task with nothing that suspends before it.
 * `core/Keyboard.ts` starts a command body with `startImmediately`, so a body
 * that only calls the manager completes inside that window.
 */

import { Effect, Layer, Match, Option, pipe } from "effect";
import { Commands } from "~/core/Commands.ts";
import { Report } from "~/core/Report.ts";
import { Clipboard } from "~/platform/Clipboard.ts";
import { Dom } from "~/platform/Dom.ts";
import { BRIEFLY, Hud } from "~/ui/Hud.ts";
import { type Destination, Navigation } from "./Navigation.ts";

/** Text with something in it besides white space. */
const hasContent = (text: string): boolean => text.trim().length > 0;

/** What the prompt asks, for each place that the URL opens in. */
const promptLabel = (destination: Destination): string =>
  pipe(
    Match.value(destination),
    Match.when("this-tab", () => "Open:"),
    Match.when("new-tab", () => "Open in new tab:"),
    Match.exhaustive,
  );

/** The commands of the URL clipboard. The layer registers them, and gives no service. */
export const UrlClipboardLayer: Layer.Layer<
  never,
  never,
  Clipboard | Commands | Dom | Hud | Navigation | Report
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const clipboard = yield* Clipboard;
    const commands = yield* Commands;
    const dom = yield* Dom;
    const hud = yield* Hud;
    const navigation = yield* Navigation;
    const report = yield* Report;

    const copy = Effect.fn("UrlClipboard.copy")(function* (text: string, label: string) {
      yield* pipe(
        clipboard.write(text),
        Effect.matchCauseEffect({
          onFailure: () => report.error(`Could not copy the ${label}`),
          onSuccess: () => hud.show(`Copied ${label}`, BRIEFLY),
        }),
      );
    });

    /** Show what the clipboard holds, when it holds anything. */
    const previewClipboard = pipe(
      clipboard.read,
      Effect.map(Option.liftPredicate(hasContent)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (text) => hud.show(`Clipboard: ${text.slice(0, 80)}`, BRIEFLY),
        }),
      ),
      Effect.ignore,
    );

    /**
     * Open a URL that the user pastes.
     *
     * The prompt is the primary path, and not a fallback. WebKit shows a
     * native paste control, or refuses outright, unless this origin wrote the
     * clipboard. The read below is only an attempt to fill the prompt, and it
     * starts first, so that it races the user and not the other way round.
     */
    const openPasted = Effect.fn("UrlClipboard.openPasted")(function* (destination: Destination) {
      yield* pipe(previewClipboard, Effect.forkDetach);

      const answer = yield* hud.prompt<never>({
        label: promptLabel(destination),
        placeholder: "paste a URL (⌘V)",
      });
      yield* pipe(
        answer,
        Option.filter(hasContent),
        Option.match({
          onNone: () => Effect.void,
          onSome: (input) => navigation.go(input.trim(), destination),
        }),
      );
    });

    yield* commands.registerAll({
      copyCurrentUrl: () =>
        pipe(
          dom.href,
          Effect.flatMap((href) => copy(href, "URL")),
        ),

      copyCurrentTitle: () =>
        pipe(
          dom.probeOrElse(
            () => dom.document.title,
            () => "",
          ),
          Effect.flatMap((title) => copy(title, "title")),
        ),

      openCopiedUrlInCurrentTab: () => openPasted("this-tab"),
      openCopiedUrlInNewTab: () => openPasted("new-tab"),
    });
  }),
);
