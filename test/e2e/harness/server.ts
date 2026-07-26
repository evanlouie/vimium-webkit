/**
 * The fixture server.
 *
 * Two ports, one document root. `file://` would have been simpler, but
 * `strict-csp.html` needs a real `Content-Security-Policy` *response header*
 * (a `<meta http-equiv>` is not equivalent — it cannot carry a policy that is
 * in force before the first byte of the document is parsed, which is exactly
 * when a `document-start` script installs its overlay), and the cross-origin
 * frame fixtures need a second origin.
 *
 * Run standalone with `deno task serve:fixtures`; Playwright starts it via
 * `webServer` in `playwright.config.ts`.
 */

import {
  FIXTURE_DIR,
  FIXTURE_HOST,
  PRIMARY_PORT,
  READY_PATH,
  SECONDARY_ORIGIN,
  SECONDARY_ORIGIN_TOKEN,
  SECONDARY_PORT,
  STRICT_CSP_FIXTURE,
  STRICT_CSP_HEADER,
} from "./config.ts";
import { extensionOf, joinPath, normaliseSegments } from "./paths.ts";
import { repoRoot } from "./root.ts";

const documentRoot = (): string => joinPath(repoRoot(), FIXTURE_DIR);

/** Hand-rolled rather than `@std/media-types`, to keep the dependency set as-is. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/** Resolve a request path inside the document root; `..` segments are dropped. */
const resolveWithin = (root: string, pathname: string): string => {
  const segments = normaliseSegments(decodeURIComponent(pathname));
  return segments.length === 0 ? root : `${root}/${segments.join("/")}`;
};

const headersFor = (pathname: string, type: string): Headers => {
  const headers = new Headers({
    "content-type": type,
    // Fixtures change while tests are being written; a cached one produces a
    // failure nobody can reproduce.
    "cache-control": "no-store",
  });
  if (pathname === STRICT_CSP_FIXTURE) {
    headers.set("content-security-policy", STRICT_CSP_HEADER);
  }
  return headers;
};

const notFound = (pathname: string): Response =>
  new Response(`No fixture at ${pathname}\n`, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const handle = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === READY_PATH) {
    return new Response("ready\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolveWithin(documentRoot(), pathname);
  const extension = extensionOf(filePath);
  const type = MIME_TYPES[extension] ?? "application/octet-stream";

  if (extension === ".html") {
    let text: string;
    try {
      text = await Deno.readTextFile(filePath);
    } catch {
      return notFound(pathname);
    }
    // Fixtures reference the second origin symbolically so the port lives in
    // exactly one place (`harness/config.ts`).
    return new Response(
      text.replaceAll(SECONDARY_ORIGIN_TOKEN, SECONDARY_ORIGIN),
      { headers: headersFor(pathname, type) },
    );
  }

  try {
    const bytes = await Deno.readFile(filePath);
    return new Response(bytes, { headers: headersFor(pathname, type) });
  } catch {
    return notFound(pathname);
  }
};

export const startFixtureServer = (): readonly Deno.HttpServer[] =>
  [PRIMARY_PORT, SECONDARY_PORT].map((port) =>
    Deno.serve({
      hostname: FIXTURE_HOST,
      port,
      onListen: ({ hostname, port: bound }) => {
        console.log(`[fixtures] http://${hostname}:${bound}/`);
      },
    }, handle)
  );

if (import.meta.main) startFixtureServer();
