/**
 * Playwright `globalSetup`: make sure the artefact under test exists, and that
 * the thing answering on the fixture port is actually ours.
 *
 * Runs once, in the main process, before any worker starts — which is exactly
 * where a build belongs, since several workers racing on one esbuild output is
 * a good way to observe a half-written file.
 */

import { READY_PATH, READY_TOKEN } from "./config.ts";
import { primaryOrigin, secondaryOrigin } from "./ports.ts";
import { ensureBundle } from "./bundle.ts";

const assertFixtureServer = async (origin: string): Promise<void> => {
  const url = `${origin}${READY_PATH}`;
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok || body.trim() !== READY_TOKEN) {
    throw new Error(
      `${url} is not the fixture server (got ${response.status} ` +
        `${JSON.stringify(body.slice(0, 80))}). Refusing to run the suite ` +
        "against an unknown host.",
    );
  }
};

const globalSetup = async (): Promise<void> => {
  await ensureBundle();
  // Both origins: the cross-origin frame fixtures are worthless if the second
  // one silently 404s, and a spec that loads nothing is a spec that passes.
  await Promise.all(
    [primaryOrigin(), secondaryOrigin()].map(assertFixtureServer),
  );
};

export default globalSetup;
