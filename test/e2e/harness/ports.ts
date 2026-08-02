/**
 * Fixture-server port allocation.
 *
 * Hard-coded ports made the suite adopt whatever happened to be listening: with
 * `reuseExistingServer` on, Playwright probes `/__ready`, gets *some* response,
 * and runs the whole suite against a foreign server (TST-09). Ports are
 * therefore allocated from the ephemeral range at run time.
 *
 * The pair has to be *stable* across the several processes involved — the
 * Playwright host, each worker (which re-evaluates `playwright.config.ts`), and
 * the fixture server subprocess — so the first resolver publishes it through the
 * environment and everyone downstream inherits it.
 *
 * Kept out of `config.ts` deliberately: that module is loaded by two runtimes
 * and must stay free of runtime-specific APIs.
 */

import { execFileSync } from "node:child_process";
import { FIXTURE_HOST } from "./config.ts";

/** Environment variable carrying the resolved `primary,secondary` pair. */
export const FIXTURE_PORTS_ENV = "VW_FIXTURE_PORTS";

export interface FixturePorts {
  readonly primary: number;
  readonly secondary: number;
}

/**
 * Ask the OS for a free port.
 *
 * There is an unavoidable gap between closing the listener and the fixture
 * server binding it. That is the same race every `port: 0` helper has, and it
 * is strictly better than a fixed port: the window is milliseconds wide and the
 * kernel does not hand out the same ephemeral port twice in that span.
 *
 * Synchronous by necessity: `playwright.config.ts` resolves the pair during
 * module evaluation, before any worker starts. Node's `listen` is asynchronous
 * and `address()` answers `null` until it completes, so the bind happens in a
 * short-lived child process that this call blocks on.
 */
const RESERVE_SCRIPT = `const s=require("node:net").createServer();` +
  `s.listen(0,process.argv[1],()=>{const a=s.address();` +
  `process.stdout.write(String(a.port));s.close()});`;

const reservePort = (): number => {
  const output = execFileSync(
    process.execPath,
    ["-e", RESERVE_SCRIPT, FIXTURE_HOST],
    { encoding: "utf8" },
  );
  const port = Number(output.trim());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not reserve an ephemeral port (got ${output})`);
  }
  return port;
};

const parsePair = (raw: string): FixturePorts | null => {
  const parts = raw.split(",");
  if (parts.length !== 2) return null;
  const primary = Number(parts[0]);
  const secondary = Number(parts[1]);
  if (!Number.isInteger(primary) || !Number.isInteger(secondary)) return null;
  if (primary <= 0 || secondary <= 0) return null;
  return { primary, secondary };
};

let cached: FixturePorts | null = null;

/** The port pair for this run, allocating and publishing it on first call. */
export const fixturePorts = (): FixturePorts => {
  if (cached !== null) return cached;

  const published = process.env[FIXTURE_PORTS_ENV];
  const parsed = published === undefined ? null : parsePair(published);
  if (parsed !== null) {
    cached = parsed;
    return cached;
  }

  let primary = reservePort();
  let secondary = reservePort();
  // Vanishingly unlikely, but a collision would make the two "origins" one.
  while (secondary === primary) secondary = reservePort();
  if (primary > secondary) [primary, secondary] = [secondary, primary];

  cached = { primary, secondary };
  process.env[FIXTURE_PORTS_ENV] = `${primary},${secondary}`;
  return cached;
};

export const primaryOrigin = (): string =>
  `http://${FIXTURE_HOST}:${fixturePorts().primary}`;

export const secondaryOrigin = (): string =>
  `http://${FIXTURE_HOST}:${fixturePorts().secondary}`;
