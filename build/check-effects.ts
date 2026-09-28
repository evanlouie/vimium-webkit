import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const cli = join(
  dirname(require.resolve("@effect/tsgo/package.json")),
  "dist/effect-tsgo.cjs",
);

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
