import { test } from "vitest";
import {
  createFrameSecret,
  signFrameJoin,
  verifyFrameJoin,
} from "~/frames/auth.ts";
import { assert, assertFalse } from "./support/assert.ts";

test("a frame join requires the manager-private credential", async () => {
  const secret = createFrameSecret();
  const proof = await signFrameJoin(secret, "challenge", "hello");

  assert(await verifyFrameJoin(secret, "challenge", "hello", proof));
  assertFalse(await verifyFrameJoin(secret, "other", "hello", proof));
  assertFalse(
    await verifyFrameJoin(createFrameSecret(), "challenge", "hello", proof),
  );
  assertFalse(await verifyFrameJoin("", "challenge", "hello", proof));
});
