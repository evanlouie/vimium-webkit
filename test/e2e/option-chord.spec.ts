/**
 * A chord with Alt, through the real browser.
 *
 * The unit tests hold the layout table, because a layout cannot be chosen from
 * a test. This spec holds the wiring: the platform probe, the key context that
 * `core/Keyboard.ts` builds, and the notation that the mapping file names.
 *
 * Playwright builds its key events from a US table, so `Alt+j` arrives with
 * `key: "j"`, `code: "KeyJ"` and `keyCode: 74`. That is the same shape that a
 * US keyboard gives, and it is enough to prove that the chord reaches its
 * command.
 *
 * `smoothScroll: false`, so the assertion reads a settled offset.
 */

import { expect, test } from "./harness/fixtures.ts";
import { DETERMINISTIC } from "./harness/settings-seed.ts";

/** The default `scrollStepSize`. */
const STEP = 60;

test.describe("an Alt chord", () => {
  test.use({
    settingsPatch: { ...DETERMINISTIC, keyMappings: "map <a-j> scrollDown" },
  });

  test("runs the command that the mapping names", async ({ vw }) => {
    await vw.open("/scrollables.html");

    await vw.page.keyboard.press("Alt+j");

    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
  });

  test("carries the legacy key code that the rule reads", async ({ vw }) => {
    await vw.open("/scrollables.html");

    // The Option rule reads `keyCode`, because it is the only field that
    // carries the character of the key with no modifier. A build of WebKit
    // that stopped sending it would make the rule fall back in silence.
    await vw.page.evaluate(() => {
      const host = globalThis as unknown as {
        __chords?: { key: string; code: string; keyCode: number }[];
      };
      host.__chords = [];
      addEventListener("keydown", (event) => {
        // The press of Alt itself is a keydown as well. It carries no
        // character, and the rule never reads it.
        if (event.key === "Alt") return;
        host.__chords?.push({
          key: event.key,
          code: event.code,
          keyCode: event.keyCode,
        });
      }, { capture: true });
    });

    await vw.page.keyboard.press("Alt+q");

    const chords = await vw.page.evaluate(() => {
      const host = globalThis as unknown as {
        __chords?: { key: string; code: string; keyCode: number }[];
      };
      return host.__chords ?? [];
    });
    expect(chords[0]).toEqual({ key: "q", code: "KeyQ", keyCode: 81 });
  });
});
