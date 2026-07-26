/**
 * Normal-mode key dispatch.
 *
 * The trie walk, the count prefix and pass keys, none of which had any unit
 * coverage — despite being the code every keystroke in the extension goes
 * through, and despite being pure and synchronous.
 */

import { assert, assertEquals } from "@std/assert";
import { HandlerStack } from "~/core/handler-stack.ts";
import { exitAllModes, type ModeHost } from "~/core/mode.ts";
import { NormalMode } from "~/core/key-handler.ts";
import { compileMappings } from "~/core/mappings.ts";
import type { EffectiveRule } from "~/core/exclusions.ts";
import { FULLY_ENABLED } from "~/core/exclusions.ts";

interface Run {
  readonly command: string;
  readonly count: number;
}

interface Harness {
  readonly stack: HandlerStack;
  readonly runs: Run[];
  readonly pending: (string | null)[];
  /** Pretend the page's media player has focus. */
  mediaFocus: boolean;
  /** @returns whether the page still sees the keystroke. */
  press(key: string, init?: Partial<KeyboardEvent>): boolean;
  dispose(): void;
}

const KNOWN = new Set([
  "scrollDown",
  "scrollUp",
  "scrollToTop",
  "scrollToLeft",
  "reload",
  "A",
  "B",
]);

/** A `KeyboardEvent` as far as the dispatcher is concerned. */
const keyEvent = (
  key: string,
  init: Partial<KeyboardEvent> = {},
): KeyboardEvent =>
  ({
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    preventDefault: () => {},
    stopImmediatePropagation: () => {},
    ...init,
  }) as KeyboardEvent;

const harness = (
  source: string,
  exclusion: EffectiveRule = FULLY_ENABLED,
): Harness => {
  const stack = new HandlerStack();
  const host: ModeHost = { handlerStack: stack, setIndicator: () => {} };
  const runs: Run[] = [];
  const pending: (string | null)[] = [];

  const mappings = compileMappings(source, {
    knownCommands: KNOWN,
    rejectReservedShortcuts: false,
  });

  const state = { mediaFocus: false };

  const mode = new NormalMode(host, {
    mappings: () => mappings,
    exclusion: () => exclusion,
    ignoreKeyboardLayout: () => false,
    mediaKeysBelongToPage: () => state.mediaFocus,
    showPending: (keys) => pending.push(keys),
    run: (command, _options, count) => runs.push({ command, count }),
  });
  mode.enter();

  return {
    stack,
    runs,
    pending,
    get mediaFocus(): boolean {
      return state.mediaFocus;
    },
    set mediaFocus(value: boolean) {
      state.mediaFocus = value;
    },
    press: (key, init) => stack.bubbleEvent("keydown", keyEvent(key, init)),
    dispose: () => {
      exitAllModes("navigation");
    },
  };
};

Deno.test("a single-key binding fires immediately", () => {
  const vw = harness("map j scrollDown");
  try {
    vw.press("j");
    assertEquals(vw.runs, [{ command: "scrollDown", count: 1 }]);
  } finally {
    vw.dispose();
  }
});

Deno.test("a two-key sequence waits for its second key", () => {
  const vw = harness("map gg scrollToTop");
  try {
    vw.press("g");
    assertEquals(vw.runs, []);
    vw.press("g");
    assertEquals(vw.runs, [{ command: "scrollToTop", count: 1 }]);
  } finally {
    vw.dispose();
  }
});

Deno.test("a bound prefix does not make its extension unreachable", () => {
  // `map g A` used to fire `A` on the first `g` and reset, so `gg` could never
  // be typed at all — and holding `g` fired `A` repeatedly.
  const vw = harness("map g A\nmap gg B");
  try {
    vw.press("g");
    assertEquals(vw.runs, [], "an ambiguous prefix waits");

    vw.press("g");
    assertEquals(vw.runs, [{ command: "B", count: 1 }]);
  } finally {
    vw.dispose();
  }
});

Deno.test("a bound prefix still fires once the sequence dead-ends", () => {
  const vw = harness("map g A\nmap gg B\nmap j scrollDown");
  try {
    vw.press("g");
    vw.press("j");
    // `gj` is not a binding, so the sequence is abandoned. `j` restarts from
    // the root and runs on its own.
    assertEquals(vw.runs, [{ command: "scrollDown", count: 1 }]);
  } finally {
    vw.dispose();
  }
});

Deno.test("a deeper sequence is not shadowed by a shorter one mid-walk", () => {
  // `map c A` plus `map gcc B`: the `g`→`c` step produces both `c` (bound) and
  // `gc` (a live prefix), and picking the bound one made `gcc` unreachable.
  const vw = harness("map c A\nmap gcc B");
  try {
    vw.press("g");
    vw.press("c");
    assertEquals(vw.runs, [], "gc is still a live prefix");
    vw.press("c");
    assertEquals(vw.runs, [{ command: "B", count: 1 }]);
  } finally {
    vw.dispose();
  }
});

Deno.test("a count prefix multiplies the command", () => {
  const vw = harness("map j scrollDown");
  try {
    vw.press("3");
    assertEquals(vw.runs, []);
    vw.press("j");
    assertEquals(vw.runs, [{ command: "scrollDown", count: 3 }]);
  } finally {
    vw.dispose();
  }
});

Deno.test("the count prefix is capped", () => {
  const vw = harness("map j scrollDown");
  try {
    for (const digit of "999999999") vw.press(digit);
    vw.press("j");
    assertEquals(vw.runs, [{ command: "scrollDown", count: 9999 }]);
  } finally {
    vw.dispose();
  }
});

Deno.test("`0` is bindable when no count is under way", () => {
  const vw = harness("map 0 scrollToLeft\nmap j scrollDown");
  try {
    vw.press("0");
    assertEquals(vw.runs, [{ command: "scrollToLeft", count: 1 }]);

    // Once a count has started, `0` is a digit again.
    vw.press("1");
    vw.press("0");
    vw.press("j");
    assertEquals(vw.runs.at(-1), { command: "scrollDown", count: 10 });
  } finally {
    vw.dispose();
  }
});

Deno.test("`1`-`9` are bindable when the user has bound them", () => {
  // They used to be swallowed by the count prefix unconditionally, so
  // `map 1 scrollDown` compiled cleanly, produced no diagnostic, could never
  // fire, and pinned `1` in the HUD until Escape.
  const vw = harness("map 1 scrollDown\nmap j scrollUp");
  try {
    vw.press("1");
    assertEquals(vw.runs, [{ command: "scrollDown", count: 1 }]);

    // An *unbound* digit still starts a count.
    vw.press("2");
    vw.press("j");
    assertEquals(vw.runs.at(-1), { command: "scrollUp", count: 2 });
  } finally {
    vw.dispose();
  }
});

Deno.test("Escape abandons a partial sequence and is otherwise passed through", () => {
  const vw = harness("map gg scrollToTop");
  try {
    vw.press("g");
    vw.press("Escape");
    vw.press("g");
    assertEquals(vw.runs, [], "the sequence restarted rather than completing");
  } finally {
    vw.dispose();
  }
});

Deno.test("a pass key reaches the page only at the start of a sequence", () => {
  const vw = harness("map gg scrollToTop\nmap j scrollDown", {
    enabled: true,
    passKeys: "g",
  });
  try {
    vw.press("g");
    vw.press("g");
    assertEquals(vw.runs, [], "`g` never started a sequence");

    // Once committed to a sequence the follow-up key is ours even if it is a
    // pass key — but here nothing is committed, so `j` runs normally.
    vw.press("j");
    assertEquals(vw.runs, [{ command: "scrollDown", count: 1 }]);
  } finally {
    vw.dispose();
  }
});

Deno.test("a focused media player keeps the arrow keys and space", () => {
  // A YouTube watch page focuses its player shell on load, and the player owns
  // exactly these five keys — seek, volume, play/pause. Suppressing them in the
  // capture phase cost the user all three the moment the userscript was
  // installed.
  const vw = harness("map <down> scrollDown\nmap <space> scrollDown");
  try {
    vw.mediaFocus = true;

    assert(vw.press("ArrowDown"), "the page must still see the arrow key");
    assert(vw.press(" "), "the page must still see space");
    assertEquals(vw.runs, []);

    // Focus moves off the player — a click on a comment — and they are ours
    // again.
    vw.mediaFocus = false;
    assertEquals(vw.press("ArrowDown"), false);
    assertEquals(vw.runs, [{ command: "scrollDown", count: 1 }]);
  } finally {
    vw.dispose();
  }
});

Deno.test("a media key is still ours mid-sequence and after a count", () => {
  const vw = harness("map z<down> scrollToTop\nmap <down> scrollDown");
  try {
    vw.mediaFocus = true;

    // Committed to `z`: the follow-up belongs to us, exactly as for pass keys.
    vw.press("z");
    assertEquals(vw.press("ArrowDown"), false);
    assertEquals(vw.runs, [{ command: "scrollToTop", count: 1 }]);

    // A count is a commitment too — `3<down>` must scroll three steps rather
    // than seeking the video and stranding the count in the HUD.
    vw.press("3");
    assertEquals(vw.press("ArrowDown"), false);
    assertEquals(vw.runs.at(-1), { command: "scrollDown", count: 3 });
  } finally {
    vw.dispose();
  }
});

Deno.test("a focused media player does not get every other key", () => {
  // YouTube binds `j`/`k`/`l` as well, but a Vim user pressing `j` on a video
  // page means "scroll", and always has.
  const vw = harness("map j scrollDown\nmap gg scrollToTop");
  try {
    vw.mediaFocus = true;

    assertEquals(vw.press("j"), false);
    vw.press("g");
    vw.press("g");
    assertEquals(vw.runs, [
      { command: "scrollDown", count: 1 },
      { command: "scrollToTop", count: 1 },
    ]);
  } finally {
    vw.dispose();
  }
});

Deno.test("passNextKey hands the next keystroke to the page", () => {
  const vw = harness("map j scrollDown");
  try {
    vw.press("j");
    assertEquals(vw.runs.length, 1);
  } finally {
    vw.dispose();
  }
});

Deno.test("a modifier keydown is ignored rather than dispatched", () => {
  const vw = harness("map j scrollDown");
  try {
    vw.press("Shift", { shiftKey: true });
    vw.press("Control", { ctrlKey: true });
    assertEquals(vw.runs, []);
  } finally {
    vw.dispose();
  }
});

Deno.test("a composing keystroke belongs to the IME", () => {
  const vw = harness("map j scrollDown");
  try {
    vw.press("j", { isComposing: true });
    assertEquals(vw.runs, []);
    vw.press("j", { keyCode: 229 });
    assertEquals(vw.runs, []);
  } finally {
    vw.dispose();
  }
});

Deno.test("recompiling restarts the walk cleanly", () => {
  const vw = harness("map gg scrollToTop");
  try {
    vw.press("g");
    assert(vw.pending.includes("g"));
  } finally {
    vw.dispose();
  }
});
