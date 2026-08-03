/**
 * A page that captures the port of a `JOIN`.
 *
 * The bundle is injected with `addInitScript`, which runs in the page's own
 * world, so this spec is the worst case: the attacker shares our realm. It
 * takes the `MessagePort` that a child frame transfers, which every listener on
 * the top window receives, and it then does the two things that the port used
 * to allow.
 *
 * 1. It reads the traffic of the link. Hint text of a document of another
 *    origin used to travel there in clear text, together with the session
 *    nonce of the `WELCOME`.
 * 2. It sends a `WELCOME` of its own. The child took the first welcome that
 *    named its attempt, so the page could re-key the frame, and the welcome of
 *    the true coordinator was then dropped as a repeat. Cross-frame hints died
 *    with it.
 *
 * Every message on a port is now sealed with a key that both ends derive from
 * the manager-private credential. The page holds the port, and the port gives
 * no access.
 */

import { expect, test } from "./harness/fixtures.ts";

/** Long enough for the handshake, and for an answer to the forged messages. */
const REPLY_WINDOW_MS = 1500;

interface CaptureResult {
  /** How many `JOIN` messages with a port the page took. */
  readonly joins: number;
  /** The `kind` of every message that travelled on a captured port. */
  readonly kinds: readonly string[];
  /** True when a payload held text of a document that the page cannot read. */
  readonly leakedLinkText: boolean;
  /** True when a payload held a value that looks like the session nonce. */
  readonly leakedNonce: boolean;
}

/**
 * Take every `JOIN` port, read it, and forge a welcome on it.
 *
 * Serialised into the page, so it closes over nothing.
 */
const capturePorts = (waitMs: number): Promise<CaptureResult> =>
  new Promise<CaptureResult>((resolve) => {
    const MAGIC = "vimium-webkit/frames";
    const NEEDLE = "Level two link";
    const result = {
      joins: 0,
      kinds: [] as string[],
      leakedLinkText: false,
      leakedNonce: false,
    };

    const onPortMessage = (event: MessageEvent): void => {
      const data: unknown = event.data;
      const kind = typeof data === "object" && data !== null
        ? String((data as Record<string, unknown>)["kind"])
        : typeof data;
      result.kinds.push(kind);

      const text = JSON.stringify(data ?? null);
      if (text.includes(NEEDLE)) result.leakedLinkText = true;
      if (typeof data === "object" && data !== null) {
        const message = data as Record<string, unknown>;
        if (typeof message["nonce"] === "string") result.leakedNonce = true;
      }
    };

    const onWindowMessage = (event: MessageEvent): void => {
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as Record<string, unknown>;
      if (message["magic"] !== MAGIC || message["kind"] !== "JOIN") return;
      const port = event.ports[0];
      if (port === undefined) return;

      result.joins += 1;
      port.addEventListener("message", onPortMessage);
      port.start();

      // A welcome that the page made up. It names the attempt that the page
      // has just read, so every check that is not cryptographic passes.
      port.postMessage({
        magic: MAGIC,
        v: 3,
        kind: "WELCOME",
        nonce: "0123456789abcdef",
        frameId: message["frameId"],
        helloId: message["helloId"],
        frames: [message["frameId"]],
      });

      // With the session in hand, ask the frame for its hints.
      port.postMessage({
        magic: MAGIC,
        v: 3,
        nonce: "0123456789abcdef",
        from: "0000000000000000",
        to: message["frameId"],
        requestId: "",
        kind: "COLLECT_HINTS",
        roundId: "captured-round",
        originFrameId: "0000000000000000",
        mode: "activate",
      });
    };

    globalThis.addEventListener("message", onWindowMessage);
    setTimeout(() => {
      globalThis.removeEventListener("message", onWindowMessage);
      resolve(result);
    }, waitMs);
  });

test.describe("a captured frame port", () => {
  test("carries nothing that the page can read or forge", async ({ vw, page }) => {
    // The listener must exist before the first handshake, so the page is set
    // up between the navigation and the wake.
    await page.goto("/nested-frames.html");
    const attack = page.evaluate(capturePorts, REPLY_WINDOW_MS);
    await vw.bootAllFrames();

    const result = await attack;

    // The attack must be live. A spec that captured no port would pass for the
    // wrong reason.
    expect(result.joins, "no JOIN port was captured").toBeGreaterThan(0);

    // Every message on the port is sealed, so the page reads a counter and a
    // string of ciphertext, and nothing else.
    expect(
      result.kinds.filter((kind) => kind !== "SEALED"),
      "a message on the port was not sealed",
    ).toEqual([]);
    expect(result.leakedNonce, "the session nonce reached the page").toBe(
      false,
    );
    expect(result.leakedLinkText, "link text of a frame reached the page")
      .toBe(false);
  });

  test("does not stop the frame from joining the true session", async ({ vw, page }) => {
    // The forged welcome must not re-key the child. If it did, the welcome of
    // the coordinator would arrive second and be dropped as a repeat, and the
    // frame would be outside the session for the life of the page.
    await page.goto("/nested-frames.html");
    const attack = page.evaluate(capturePorts, REPLY_WINDOW_MS);
    await vw.bootAllFrames();
    await attack;

    await vw.startHints();
    await vw.activateHint("Level two link");

    await expect.poll(() => {
      const frame = page.frames().find((candidate) =>
        candidate.url().includes("level2.html")
      );
      return frame?.url() ?? "";
    }).toContain("#level2-target");
  });
});
