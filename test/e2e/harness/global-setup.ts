/**
 * Playwright `globalSetup`: make sure the artefact under test exists.
 *
 * Runs once, in the main process, before any worker starts — which is exactly
 * where a build belongs, since several workers racing on one esbuild output is
 * a good way to observe a half-written file.
 */

import { ensureBundle } from "./bundle.ts";

const globalSetup = async (): Promise<void> => {
  await ensureBundle();
};

export default globalSetup;
