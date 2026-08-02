import { test } from "vitest";
import { HandlerStack } from "~/core/handler-stack.ts";
import {
  activeModeNames,
  exitAllModes,
  type ExitReason,
  isEscape,
  Mode,
  type ModeHost,
  type ModeIndicator,
} from "~/core/mode.ts";
import { assert, assertEquals, assertFalse } from "./support/assert.ts";

interface Harness {
  readonly host: ModeHost;
  readonly stack: HandlerStack;
  readonly indicators: ModeIndicator[];
}

const harness = (): Harness => {
  const stack = new HandlerStack();
  const indicators: ModeIndicator[] = [];
  return {
    stack,
    indicators,
    host: {
      handlerStack: stack,
      setIndicator: (indicator) => {
        indicators.push(indicator);
      },
    },
  };
};

/**
 * `Mode` keeps module-level singleton and active-mode registries, so a test
 * that leaves a mode entered corrupts the next one.
 */
const clean = (fn: () => void): () => void => () => {
  try {
    fn();
  } finally {
    exitAllModes("navigation");
  }
};

test(
  "a mode can be entered, exited, and entered again",
  clean(() => {
    const { host, stack } = harness();
    const mode = new Mode(host, { name: "demo" });

    assertFalse(mode.isActive);
    assertEquals(stack.depth, 0);

    mode.enter();
    assert(mode.isActive);
    assertEquals(stack.depth, 1);

    mode.exit();
    assertFalse(mode.isActive);
    assertEquals(stack.depth, 0);

    // The regression: `#exited` used to latch, so the second `enter()` pushed a
    // handler while `isActive` still answered `false`.
    mode.enter();
    assert(mode.isActive);
    assertEquals(stack.depth, 1);

    mode.exit();
    assertFalse(mode.isActive);
    assertEquals(stack.depth, 0);
    assertEquals(activeModeNames(), []);
  }),
);

test(
  "repeated enter/exit cycles do not grow the handler stack",
  clean(() => {
    const { host, stack } = harness();
    const mode = new Mode(host, { name: "cycle" });

    for (let i = 0; i < 8; i++) {
      mode.enter();
      assertEquals(stack.depth, 1);
      mode.exit();
      assertEquals(stack.depth, 0);
    }
    assertEquals(activeModeNames(), []);
  }),
);

test(
  "entering twice without an exit is a no-op",
  clean(() => {
    const { host, stack } = harness();
    const mode = new Mode(host, { name: "idempotent" });

    mode.enter();
    mode.enter();
    assertEquals(stack.depth, 1);
    assertEquals(activeModeNames(), ["idempotent"]);

    mode.exit();
    assertEquals(stack.depth, 0);
  }),
);

test(
  "onExit fires once per exit, with the reason",
  clean(() => {
    const { host } = harness();
    const mode = new Mode(host, { name: "reasons" });
    const reasons: ExitReason[] = [];

    mode.enter();
    mode.onExit((reason) => reasons.push(reason));
    mode.exit("escape");
    assertEquals(reasons, ["escape"]);

    // A second exit on an already-exited mode must not re-fire.
    mode.exit("explicit");
    assertEquals(reasons, ["escape"]);

    // Handlers are per-entry: a fresh one registered after re-entry fires on
    // the next exit, and the previous one does not fire again.
    mode.enter();
    mode.onExit((reason) => reasons.push(reason));
    mode.exit("blur");
    assertEquals(reasons, ["escape", "blur"]);
  }),
);

test(
  "onExit on a live re-entered mode queues rather than firing immediately",
  clean(() => {
    const { host } = harness();
    const mode = new Mode(host, { name: "queued" });

    mode.enter();
    mode.exit();
    mode.enter();

    let fired = 0;
    // The bug this pins: with `#exited` latched, registration itself invoked
    // the handler, so every feature that used `onExit` to schedule cleanup ran
    // its cleanup before the mode had done anything.
    mode.onExit(() => fired++);
    assertEquals(fired, 0);

    mode.exit();
    assertEquals(fired, 1);
  }),
);

test(
  "a throwing exit handler does not stop the others",
  clean(() => {
    const { host } = harness();
    const mode = new Mode(host, { name: "throwing" });
    const seen: string[] = [];

    const console_ = console.error;
    console.error = () => {};
    try {
      mode.enter();
      mode.onExit(() => {
        seen.push("first");
        throw new Error("boom");
      });
      mode.onExit(() => seen.push("second"));
      mode.exit();
    } finally {
      console.error = console_;
    }

    assertEquals(seen, ["first", "second"]);
  }),
);

test(
  "a singleton group holds exactly one live mode",
  clean(() => {
    const { host, stack } = harness();
    const first = new Mode(host, { name: "first", singleton: "group" });
    const second = new Mode(host, { name: "second", singleton: "group" });

    first.enter();
    assertEquals(activeModeNames(), ["first"]);

    second.enter();
    assertFalse(first.isActive);
    assert(second.isActive);
    assertEquals(activeModeNames(), ["second"]);
    assertEquals(stack.depth, 1);

    // Re-entering the displaced mode must displace the other one in turn,
    // rather than silently pushing a second handler for the same group.
    first.enter();
    assertFalse(second.isActive);
    assertEquals(activeModeNames(), ["first"]);
    assertEquals(stack.depth, 1);

    first.exit();
    assertEquals(stack.depth, 0);
  }),
);

test(
  "the indicator falls back to the innermost mode that has one",
  clean(() => {
    const { host, indicators } = harness();
    const outer = new Mode(host, { name: "outer", indicator: "OUTER" });
    const silent = new Mode(host, { name: "silent" });

    outer.enter();
    assertEquals(indicators.at(-1), "OUTER");

    silent.enter();
    assertEquals(indicators.at(-1), "OUTER");

    outer.exit();
    assertEquals(indicators.at(-1), null);

    silent.exit();
  }),
);

test(
  "exitAllModes clears the stack whatever the nesting",
  clean(() => {
    const { host, stack } = harness();
    const modes = ["a", "b", "c"].map((name) => new Mode(host, { name }));
    for (const mode of modes) mode.enter();

    assertEquals(stack.depth, 3);
    exitAllModes("navigation");
    assertEquals(stack.depth, 0);
    assertEquals(activeModeNames(), []);
    for (const mode of modes) assertFalse(mode.isActive);
  }),
);

test("isEscape accepts Escape and <c-[>", () => {
  const event = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    init as KeyboardEvent;

  assert(isEscape(event({ key: "Escape" })));
  assert(isEscape(event({ key: "[", ctrlKey: true })));
  assert(isEscape(event({ key: "Dead", code: "BracketLeft", ctrlKey: true })));
  assertFalse(isEscape(event({ key: "[", ctrlKey: false })));
  assertFalse(isEscape(event({ key: "a", ctrlKey: true })));
});
