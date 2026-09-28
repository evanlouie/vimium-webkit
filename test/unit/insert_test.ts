/**
 * Insert mode: which node the focus events name.
 *
 * A `focus` or a `blur` that starts inside a shadow root is retargeted to the
 * host before a window listener sees it. `composedTarget` gives the true node
 * back. The tests here press the two cases that matter. An open root puts the
 * field at the head of the path. An empty path leaves the retargeted target as
 * the only answer there is.
 */

import { assert, describe, it } from "@effect/vitest";
import { composedTarget } from "~/features/Insert.ts";

/** A focus event with the path that the browser would build. */
const focusEvent = (
  path: ReadonlyArray<EventTarget>,
  target: EventTarget | null,
): Pick<Event, "composedPath" | "target"> => ({
  composedPath: () => [...path],
  target,
});

describe("composedTarget", () => {
  it("gives the node inside an open shadow root, not the host", () => {
    const field = new EventTarget();
    const host = new EventTarget();
    // What a focus inside an open shadow root looks like at the window: the
    // path starts at the field, and `target` is already the host.
    const event = focusEvent([field, host], host);

    assert.strictEqual(composedTarget(event), field);
  });

  it("gives the target when the path is empty", () => {
    const target = new EventTarget();

    assert.strictEqual(composedTarget(focusEvent([], target)), target);
  });

  it("gives the host of a closed shadow root", () => {
    // A closed root retargets the path as well, so the host is the first entry
    // and the answer stays the host. Our own overlay needs exactly that.
    const host = new EventTarget();

    assert.strictEqual(composedTarget(focusEvent([host], host)), host);
  });
});
