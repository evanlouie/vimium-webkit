/**
 * Does the artefact actually boot?
 *
 * Size is not correctness, and a bundler will happily produce a smaller bundle
 * that is also a dead one. During the Effect migration a tree-shaking setting
 * (`moduleSideEffects: false`) cut the bundle by 60% and made it throw on the
 * first line, because Effect builds prototypes and registries at module scope.
 * Every size check passed. Only running it found the fault.
 *
 * So the build evaluates its own output in the browser it ships for, and looks
 * for the one thing a userscript must do: install itself without throwing.
 */

import { readFile } from "node:fs/promises";

export interface BootResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Set to skip the check when no browser is installed. Prints a warning. */
const SKIP = "VIMIUM_SKIP_BOOT_CHECK";

export const verifyBundleBoots = async (
  artefactPath: string,
): Promise<BootResult> => {
  if (process.env[SKIP] === "1") {
    console.warn(`warning: ${SKIP}=1 — the bundle was not executed`);
    return { ok: true };
  }

  const source = await readFile(artefactPath, "utf8");

  const { webkit } = await import("playwright");
  let browser: Awaited<ReturnType<typeof webkit.launch>> | undefined;
  try {
    browser = await webkit.launch();
  } catch (cause) {
    return {
      ok: false,
      error:
        `could not launch WebKit (${
          cause instanceof Error ? cause.message : String(cause)
        }).\n` +
        `  Run \`npm run test:e2e:install\`, or set ${SKIP}=1 to skip this check.`,
    };
  }

  try {
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));

    // A real document, at the point a userscript at `document-start` sees one.
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.evaluate(source);

    // Give any microtask-deferred boot work a turn to throw.
    await page.evaluate(() => new Promise((done) => setTimeout(done, 50)));

    if (failures.length > 0) {
      return { ok: false, error: failures.join("; ") };
    }
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    await browser.close();
  }
};
