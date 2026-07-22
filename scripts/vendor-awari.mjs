// Re-vendor the local @awari packages into vendor/awari/ as tarballs.
//
// Kikorin's entity-ownership state handoff (ADR 0022) consumes awari's
// entity-ownership API (awari ADR 0020), which isn't in any published @awari
// release yet — it lives in the sibling ../awari working tree. We depend on it
// via `file:` tarballs (see the root package.json `pnpm.overrides`) rather than
// a `link:` to the source dir, because Turbopack won't resolve a symlink that
// points outside the app root; an extracted tarball is real files in the store.
//
// Run this after changing awari, then `pnpm install` to pick up the new
// tarballs. Retire the whole arrangement once kikorin can depend on a published
// @awari that carries the entity API.
//
// Usage: node scripts/vendor-awari.mjs [path-to-awari-repo]   (default: ../awari)

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const kikorinRoot = resolve(here, "..");
const awariRoot = resolve(kikorinRoot, process.argv[2] ?? "../awari");
const dest = join(kikorinRoot, "vendor", "awari");

const PACKAGES = ["awari-protocol", "awari-core", "awari-transport-peerjs"];

mkdirSync(dest, { recursive: true });

for (const pkg of PACKAGES) {
  const cwd = join(awariRoot, "packages", pkg);
  console.log(`packing ${pkg} → vendor/awari/`);
  // `pnpm pack` rewrites the package's workspace:* deps to concrete versions,
  // so the tarballs install standalone; the root overrides point the three
  // @awari specifiers (including each other's) at these tarballs.
  execFileSync("pnpm", ["pack", "--pack-destination", dest], { cwd, stdio: "inherit", shell: true });
}

console.log("\nDone. Now run: pnpm install");
