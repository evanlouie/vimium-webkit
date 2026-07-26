/**
 * The frame protocol's admission checks, exercised by a hostile page.
 *
 * The bundle is injected with `addInitScript`, which runs in the page's own
 * world — so these tests are the *worst* case, the one where the attacker
 * shares our realm and can read every message event we receive. If admission
 * holds here it holds in a content world too.
 *
 * The attack this pins was a complete break: the coordinator admitted any
 * `HELLO` whose `event.source` was a window in the frames tree, and
 * short-circuited "known" for its own window. So a page could post itself a
 * `HELLO` with a port attached and receive, by return, the session nonce and
 * the user's entire settings object — exclusion rules, key mappings, search
 * engines. Holding the nonce it could then run hint rounds across every
 * cross-origin frame on the page and read their link text back, and drive a
 * programmatic click inside them.
 */

import { expect, test } from "./harness/fixtures.ts";

/** Long enough for a `WELCOME` or a `CHALLENGE` to have come back if it were going to. */
const REPLY_WINDOW_MS = 500;

interface ProbeResult {
  readonly welcomed: boolean;
  readonly challenged: boolean;
  readonly settingsLeaked: boolean;
  readonly nonceLeaked: boolean;
}

/**
 * Impersonate a frame from the page's own script.
 *
 * Tries both shapes: the original one-shot `HELLO`-with-port, and the current
 * announce-then-join, in case a future refactor reintroduces either.
 */
const probeSelfAdmission = (waitMs: number): Promise<ProbeResult> =>
  new Promise<ProbeResult>((resolve) => {
    const MAGIC = "vimium-webkit/frames";
    const result = {
      welcomed: false,
      challenged: false,
      settingsLeaked: false,
      nonceLeaked: false,
    };

    const readPort = (data: unknown): void => {
      if (typeof data !== "object" || data === null) return;
      const message = data as Record<string, unknown>;
      if (message["magic"] !== MAGIC || message["kind"] !== "WELCOME") return;
      result.welcomed = true;
      result.nonceLeaked = typeof message["nonce"] === "string";
      result.settingsLeaked = message["settings"] !== undefined;
    };

    const onWindowMessage = (event: MessageEvent): void => {
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as Record<string, unknown>;
      if (message["magic"] !== MAGIC) return;
      if (message["kind"] === "CHALLENGE") result.challenged = true;
      // A `WELCOME` should never arrive over `window.postMessage`, but if the
      // transport ever changed, the leak would be the same.
      readPort(data);
    };

    globalThis.addEventListener("message", onWindowMessage);

    const withPort = new MessageChannel();
    withPort.port1.addEventListener(
      "message",
      (event: MessageEvent) => readPort(event.data),
    );
    withPort.port1.start();

    // Shape 1: the original attack — one `HELLO`, port attached, addressed at
    // our own window.
    globalThis.postMessage(
      { magic: MAGIC, v: 1, kind: "HELLO" },
      "*",
      [withPort.port2],
    );

    // Shape 2: announce, then try to redeem a token we were never issued.
    globalThis.postMessage({ magic: MAGIC, v: 1, kind: "HELLO" }, "*");
    const forged = new MessageChannel();
    forged.port1.addEventListener(
      "message",
      (event: MessageEvent) => readPort(event.data),
    );
    forged.port1.start();
    globalThis.postMessage(
      { magic: MAGIC, v: 1, kind: "JOIN", token: "guessed", helloId: "x" },
      "*",
      [forged.port2],
    );

    setTimeout(() => {
      globalThis.removeEventListener("message", onWindowMessage);
      withPort.port1.close();
      forged.port1.close();
      resolve(result);
    }, waitMs);
  });

test.describe("frame admission", () => {
  test("a page cannot admit itself as a frame", async ({ vw, page }) => {
    await vw.open("/index.html");

    const result = await page.evaluate(probeSelfAdmission, REPLY_WINDOW_MS);

    expect(result.welcomed, "the page was admitted as a frame").toBe(false);
    expect(result.challenged, "the coordinator challenged its own window")
      .toBe(false);
    expect(result.nonceLeaked, "the session nonce reached the page").toBe(
      false,
    );
    expect(result.settingsLeaked, "settings reached the page").toBe(false);
  });

  test("a page in a framed document cannot admit itself either", async ({ vw, page }) => {
    // Same check with real frames present, so the frames-tree walk is live and
    // `isKnownWindow` is being asked a question it can answer either way.
    await vw.open("/nested-frames.html");
    await vw.bootAllFrames();

    const result = await page.evaluate(probeSelfAdmission, REPLY_WINDOW_MS);

    expect(result.welcomed).toBe(false);
    expect(result.nonceLeaked).toBe(false);
    expect(result.settingsLeaked).toBe(false);
  });

  test("settings never cross the frame boundary at all", async ({ vw, page }) => {
    // Even a legitimately admitted frame must not receive them: they carry the
    // user's exclusion patterns and a CSS string that would land in a
    // stylesheet. Every frame reads its own storage instead.
    await vw.open("/nested-frames.html");
    await vw.bootAllFrames();

    const sawSettings = await page.evaluate(
      (waitMs: number) =>
        new Promise<boolean>((resolve) => {
          let seen = false;
          const onMessage = (event: MessageEvent): void => {
            const data: unknown = event.data;
            if (typeof data !== "object" || data === null) return;
            const message = data as Record<string, unknown>;
            if (message["magic"] !== "vimium-webkit/frames") return;
            if (message["settings"] !== undefined) seen = true;
          };
          globalThis.addEventListener("message", onMessage);
          setTimeout(() => {
            globalThis.removeEventListener("message", onMessage);
            resolve(seen);
          }, waitMs);
        }),
      REPLY_WINDOW_MS,
    );

    expect(sawSettings).toBe(false);
  });
});
