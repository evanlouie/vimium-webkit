import { spawnSync } from "node:child_process";
import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const cli = join(
  dirname(require.resolve("@effect/tsgo/package.json")),
  "dist/effect-tsgo.js",
);
const located = spawnSync(process.execPath, [cli, "get-exe-path"], {
  encoding: "utf8",
});

if (located.status !== 0) {
  process.stderr.write(located.stderr);
  process.exit(located.status ?? 1);
}

const executable = located.stdout.trim();
if (executable.length === 0) {
  throw new Error("Effect TypeScript-Go returned no executable path");
}

// The platform packages currently publish the native binary without its
// executable bit. Restore it before each check. This is safe on platforms that
// already preserve the bit and keeps a clean `npm ci` usable in Linux CI.
await chmod(executable, 0o755);

const diagnostics = spawnSync(
  process.execPath,
  [
    cli,
    "diagnostics",
    "--project",
    "tsconfig.src.json",
    "--strict",
  ],
  { stdio: "inherit" },
);

process.exit(diagnostics.status ?? 1);
