/**
 * The handler stack.
 *
 * Pure, synchronous and DOM-free, and it was at 0% function coverage — despite
 * being the thing every keystroke in the extension passes through.
 */

import { test } from "vitest";
import {
  CONTINUE_BUBBLING,
  type Handler,
  HandlerStack,
  PASS_EVENT_TO_PAGE,
  RESTART_BUBBLING,
  SUPPRESS_EVENT,
  SUPPRESS_PROPAGATION,
} from "~/core/handler-stack.ts";
import { assert, assertEquals, assertFalse } from "./support/assert.ts";

interface FakeEvent {
  prevented: boolean;
  stopped: boolean;
}

/** A `KeyboardEvent` as far as the stack is concerned: two methods it may call. */
const fakeEvent = (): FakeEvent & KeyboardEvent => {
  const state = { prevented: false, stopped: false };
  return {
    ...state,
    get prevented(): boolean {
      return state.prevented;
    },
    get stopped(): boolean {
      return state.stopped;
    },
    preventDefault: () => {
      state.prevented = true;
    },
    stopImmediatePropagation: () => {
      state.stopped = true;
    },
  } as unknown as FakeEvent & KeyboardEvent;
};

test("push and unshift decide who sees an event first", () => {
  const stack = new HandlerStack();
  const seen: string[] = [];
  const record = (name: string): Handler => ({
    name,
    keydown: () => {
      seen.push(name);
      return CONTINUE_BUBBLING;
    },
  });

  stack.push(record("first"));
  stack.push(record("second"));
  stack.unshift(record("bottom"));

  assertEquals(stack.depth, 3);
  assertEquals(stack.names, ["bottom", "first", "second"]);

  stack.bubbleEvent("keydown", fakeEvent());
  // Innermost first, bottom last.
  assertEquals(seen, ["second", "first", "bottom"]);
});

test("every handler below the top runs, exactly once", () => {
  // The regression, in the shape it was reported: with the walk indexing into
  // the live array, a handler that removes an entry *below* itself shifts
  // everything under it up by one — so the already-visited top handler is
  // visited a second time and the entry below it is never visited at all.
  // Observed as `C,C,A` where `C,B,A` was correct.
  const stack = new HandlerStack();
  const seen: string[] = [];

  stack.push({
    name: "A",
    keydown: () => {
      seen.push("A");
      return CONTINUE_BUBBLING;
    },
  });
  const middle = stack.push({
    name: "B",
    keydown: () => {
      seen.push("B");
      return CONTINUE_BUBBLING;
    },
  });
  stack.push({
    name: "C",
    keydown: () => {
      seen.push("C");
      stack.remove(middle);
      return CONTINUE_BUBBLING;
    },
  });

  stack.bubbleEvent("keydown", fakeEvent());

  assertEquals(seen, ["C", "A"]);
});

test("a handler removed mid-walk does not still see the event", () => {
  const stack = new HandlerStack();
  const seen: string[] = [];

  let victim = 0;
  stack.push({
    name: "remover",
    keydown: () => {
      seen.push("remover");
      stack.remove(victim);
      return CONTINUE_BUBBLING;
    },
  });
  victim = stack.unshift({
    name: "victim",
    keydown: () => {
      seen.push("victim");
      return CONTINUE_BUBBLING;
    },
  });

  stack.bubbleEvent("keydown", fakeEvent());
  assertEquals(seen, ["remover"]);
});

test("SUPPRESS_EVENT prevents the default and stops propagation", () => {
  const stack = new HandlerStack();
  let reachedBelow = false;
  stack.push({
    name: "below",
    keydown: () => {
      reachedBelow = true;
      return CONTINUE_BUBBLING;
    },
  });
  stack.push({ name: "top", keydown: () => SUPPRESS_EVENT });

  const event = fakeEvent();
  assertEquals(stack.bubbleEvent("keydown", event), false);
  assertEquals(event.prevented, true);
  assertEquals(event.stopped, true);
  assertFalse(reachedBelow);
});

test("SUPPRESS_PROPAGATION leaves the default action alone", () => {
  const stack = new HandlerStack();
  stack.push({ name: "top", keydown: () => SUPPRESS_PROPAGATION });

  const event = fakeEvent();
  assertEquals(stack.bubbleEvent("keydown", event), false);
  assertEquals(event.prevented, false);
  assertEquals(event.stopped, true);
});

test("PASS_EVENT_TO_PAGE stops the walk without touching the event", () => {
  const stack = new HandlerStack();
  let reachedBelow = false;
  stack.push({
    name: "below",
    keydown: () => {
      reachedBelow = true;
      return CONTINUE_BUBBLING;
    },
  });
  stack.push({ name: "top", keydown: () => PASS_EVENT_TO_PAGE });

  const event = fakeEvent();
  assertEquals(stack.bubbleEvent("keydown", event), true);
  assertEquals(event.prevented, false);
  assertEquals(event.stopped, false);
  assertFalse(reachedBelow);
});

test("RESTART_BUBBLING re-runs the stack, including what was just pushed", () => {
  const stack = new HandlerStack();
  const seen: string[] = [];
  let pushed = false;

  stack.push({
    name: "opener",
    keydown: () => {
      seen.push("opener");
      if (pushed) return CONTINUE_BUBBLING;
      pushed = true;
      stack.push({
        name: "opened",
        keydown: () => {
          seen.push("opened");
          return SUPPRESS_EVENT;
        },
      });
      return RESTART_BUBBLING;
    },
  });

  assertEquals(stack.bubbleEvent("keydown", fakeEvent()), false);
  assertEquals(seen, ["opener", "opened"]);
});

test("an event with no interested handler reaches the page", () => {
  const stack = new HandlerStack();
  stack.push({ name: "keys-only", keydown: () => SUPPRESS_EVENT });
  assertEquals(
    stack.bubbleEvent("click", fakeEvent() as unknown as MouseEvent),
    true,
  );
});

test("a throwing handler is dropped and the walk continues", () => {
  const stack = new HandlerStack();
  const errors: string[] = [];
  stack.onHandlerError((message) => errors.push(message));

  let reachedBelow = false;
  stack.push({
    name: "below",
    keydown: () => {
      reachedBelow = true;
      return CONTINUE_BUBBLING;
    },
  });
  const thrower = stack.push({
    name: "thrower",
    keydown: () => {
      throw new Error("boom");
    },
  });

  assertEquals(stack.bubbleEvent("keydown", fakeEvent()), true);
  assert(reachedBelow, "a throwing frame must not wedge the pipeline");
  assertFalse(stack.has(thrower), "and must not stay on the stack");
  assertEquals(errors.length, 1);
  assert(errors[0]?.includes("thrower"));
});

test("remove() defaults to the handler currently running", () => {
  const stack = new HandlerStack();
  let self = 0;
  self = stack.push({
    name: "self-removing",
    keydown: () => {
      stack.remove();
      return CONTINUE_BUBBLING;
    },
  });

  stack.bubbleEvent("keydown", fakeEvent());
  assertFalse(stack.has(self));
  assertEquals(stack.depth, 0);
});

test("remove() outside a walk removes nothing", () => {
  const stack = new HandlerStack();
  stack.push({ name: "kept", keydown: () => CONTINUE_BUBBLING });
  stack.remove();
  assertEquals(stack.depth, 1);
});

test("reset drops everything", () => {
  const stack = new HandlerStack();
  stack.push({ name: "a", keydown: () => CONTINUE_BUBBLING });
  stack.push({ name: "b", keydown: () => CONTINUE_BUBBLING });
  stack.reset();
  assertEquals(stack.depth, 0);
  assertEquals(stack.names, []);
});
