/**
 * The fixture server.
 *
 * Two ports, one document root, both allocated at run time (`ports.ts`).
 * `file://` would have been simpler, but
 * `strict-csp.html` needs a real `Content-Security-Policy` *response header*
 * (a `<meta http-equiv>` is not equivalent — it cannot carry a policy that is
 * in force before the first byte of the document is parsed, which is exactly
 * when a `document-start` script installs its overlay), and the cross-origin
 * frame fixtures need a second origin.
 *
 * Run standalone with `npm run serve:fixtures`; Playwright starts it via
 * `webServer` in `playwright.config.ts`.
 */

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  FIXTURE_DIR,
  FIXTURE_HOST,
  READY_PATH,
  READY_TOKEN,
  SECONDARY_ORIGIN_TOKEN,
  STRICT_CSP_FIXTURE,
  STRICT_CSP_HEADER,
} from "./config.ts";
import { extensionOf, joinPath, normaliseSegments } from "./paths.ts";
import { fixturePorts, secondaryOrigin } from "./ports.ts";
import { repoRoot } from "./root.ts";

const documentRoot = (): string => joinPath(repoRoot(), FIXTURE_DIR);

/** Hand-rolled rather than a media-type library, to keep the dependency set small. */
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

const headersFor = (
  pathname: string,
  type: string,
): Record<string, string> => {
  const headers: Record<string, string> = {
    "content-type": type,
    // Fixtures change while tests are being written; a cached one produces a
    // failure nobody can reproduce.
    "cache-control": "no-store",
  };
  if (pathname === STRICT_CSP_FIXTURE) {
    headers["content-security-policy"] = STRICT_CSP_HEADER;
  }
  return headers;
};

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string | Uint8Array;
}

const notFound = (pathname: string): Reply => ({
  status: 404,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: `No fixture at ${pathname}\n`,
});

const handle = async (requestUrl: string): Promise<Reply> => {
  const url = new URL(requestUrl, `http://${FIXTURE_HOST}`);
  if (url.pathname === READY_PATH) {
    // Identifies *this* server, so an unrelated process answering on the same
    // port cannot be mistaken for the fixture host.
    return {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: `${READY_TOKEN}\n`,
    };
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolveWithin(documentRoot(), pathname);
  const extension = extensionOf(filePath);
  const type = MIME_TYPES[extension] ?? "application/octet-stream";

  if (extension === ".html") {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      return notFound(pathname);
    }
    // Fixtures reference the second origin symbolically so the port lives in
    // exactly one place (`harness/config.ts`).
    return {
      status: 200,
      headers: headersFor(pathname, type),
      body: text.replaceAll(SECONDARY_ORIGIN_TOKEN, secondaryOrigin()),
    };
  }

  try {
    const bytes = await readFile(filePath);
    return { status: 200, headers: headersFor(pathname, type), body: bytes };
  } catch {
    return notFound(pathname);
  }
};

export const startFixtureServer = (): readonly Server[] => {
  const { primary, secondary } = fixturePorts();
  return [primary, secondary].map((port) => {
    const server = createServer((request, response) => {
      void handle(request.url ?? "/").then((reply) => {
        response.writeHead(reply.status, reply.headers);
        response.end(reply.body);
      }).catch(() => {
        response.writeHead(500, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("fixture server error\n");
      });
    });
    server.listen(port, FIXTURE_HOST, () => {
      console.log(`[fixtures] http://${FIXTURE_HOST}:${port}/`);
    });
    return server;
  });
};

// `tsx` runs this module as the process entry point when started directly.
if (process.argv[1] !== undefined && import.meta.url.endsWith("server.ts")) {
  const invokedDirectly = process.argv[1].endsWith("server.ts");
  if (invokedDirectly) startFixtureServer();
}
