/**
 * Constants shared by the Playwright config, the fixture server, and the specs.
 *
 * This module is loaded by *two different runtimes* — Deno (for the fixture
 * server and `deno check`) and Playwright's own loader (for the config and the
 * specs) — so it must stay free of imports and of anything runtime-specific.
 */

export const FIXTURE_HOST = "127.0.0.1";

/**
 * The ports themselves live in `ports.ts`.
 *
 * They are allocated from the ephemeral range per run rather than hard-coded,
 * so the suite can never adopt a foreign server that happens to answer on a
 * well-known port. Two ports on the same host are two different *origins*,
 * which is all the cross-origin frame fixtures need: `postMessage`,
 * `MessageChannel` transfer, and `document.domain` all behave exactly as they
 * do across hostnames.
 */

/** Cheap liveness endpoint for Playwright's `webServer.url`. */
export const READY_PATH = "/__ready";

/**
 * What `READY_PATH` answers with.
 *
 * Playwright's `webServer` readiness probe only checks that *something*
 * responds. A token lets `globalSetup` assert the responder is the fixture
 * server rather than an unrelated process (TST-09).
 */
export const READY_TOKEN = "vimium-webkit-fixtures";

/**
 * Token substituted into `.html` fixtures by the server.
 *
 * The alternative — hard-coding a port into the markup — would mean editing
 * every fixture to move a port, and a fixture that silently loads nothing is a
 * test that silently passes.
 */
export const SECONDARY_ORIGIN_TOKEN = "%SECONDARY_ORIGIN%";

/** Path (relative to the repo root) of the directory the server serves. */
export const FIXTURE_DIR = "test/fixtures";

/** The document the CSP fixture lives at; the server adds the header for it. */
export const STRICT_CSP_FIXTURE = "/strict-csp.html";

/**
 * The policy `strict-csp.html` is served with.
 *
 * `style-src 'self'` with no `'unsafe-inline'` is the whole point: it is what
 * blocks a `<style>` element injected by a content script on WebKit, and what
 * a constructed stylesheet adopted into a shadow root is expected to survive
 * (IMPLEMENTATION_PLAN.md §6.3, §7.2, verification item V1).
 */
export const STRICT_CSP_HEADER = "default-src 'self'; style-src 'self'";
