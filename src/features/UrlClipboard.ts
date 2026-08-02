/**
 * Copying the URL of this page, and opening a URL that the user pasted.
 *
 * The write path is activation-sensitive. WebKit spends the transient user
 * activation on the first suspension, so the clipboard write must be reached
 * from the key task with nothing that suspends before it.
 * `core/Keyboard.ts` starts a command body with `startImmediately`, so a body
 * that only calls the manager completes inside that window.
 */

import { Context, Effect, Layer, Option } from "effect";
import { Commands } from "~/core/Commands.ts";
import { Report } from "~/core/Report.ts";
import { Clipboard } from "~/platform/Clipboard.ts";
import { Dom } from "~/platform/Dom.ts";
import { Hud } from "~/ui/Hud.ts";
import { Navigation } from "./Navigation.ts";

export class UrlClipboard extends Context.Service<UrlClipboard, {
  /** Copy text, and tell the user what was copied. */
  readonly copy: (text: string, label: string) => Effect.Effect<void>;
}>()("vimium/features/UrlClipboard") {
  static readonly layer: Layer.Layer<
    UrlClipboard,
    never,
    Clipboard | Commands | Dom | Hud | Navigation | Report
  > = Layer.effect(
    UrlClipboard,
    Effect.gen(function*() {
      const clipboard = yield* Clipboard;
      const commands = yield* Commands;
      const dom = yield* Dom;
      const hud = yield* Hud;
      const navigation = yield* Navigation;
      const report = yield* Report;

      const copy = Effect.fn("UrlClipboard.copy")(
        function*(text: string, label: string) {
          const outcome = yield* Effect.exit(clipboard.write(text));
          if (outcome._tag === "Failure") {
            yield* report.error(`Could not copy the ${label}`);
            return;
          }
          yield* hud.show(`Copied ${label}`);
        },
      );

      /**
       * Open a URL that the user pastes.
       *
       * The prompt is the primary path, and not a fallback. WebKit shows a
       * native paste control, or refuses outright, unless this origin wrote the
       * clipboard. The read below is only an attempt to fill the prompt, and it
       * starts first, so that it races the user and not the other way round.
       */
      const openPasted = Effect.fn("UrlClipboard.openPasted")(
        function*(newTab: boolean) {
          yield* Effect.forkDetach(
            Effect.ignore(
              Effect.flatMap(clipboard.read, (text) =>
                text.trim().length === 0
                  ? Effect.void
                  : hud.show(`Clipboard: ${text.slice(0, 80)}`)),
            ),
          );

          const answer = yield* hud.prompt<never>({
            label: newTab ? "Open in new tab:" : "Open:",
            placeholder: "paste a URL (⌘V)",
          });
          if (Option.isNone(answer) || answer.value.trim().length === 0) return;
          yield* navigation.go(answer.value.trim(), { newTab });
        },
      );

      yield* commands.registerAll({
        copyCurrentUrl: () =>
          Effect.flatMap(dom.href, (href) => copy(href, "URL")),

        copyCurrentTitle: () =>
          Effect.flatMap(
            dom.probeOr(() => dom.document.title, ""),
            (title) => copy(title, "title"),
          ),

        openCopiedUrlInCurrentTab: () => openPasted(false),
        openCopiedUrlInNewTab: () => openPasted(true),
      });

      return UrlClipboard.of({ copy });
    }),
  );
}
