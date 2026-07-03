// Copies the committed WASM binary from @kikorin/engine-wasm into public/ so the
// engine worker can fetch /engine_bg.wasm at runtime. Runs as part of the web build
// so deploy environments (Vercel — no Rust toolchain) never need wasm-pack; the
// binary in crates/engine/pkg/ is the committed artifact, rebuilt locally via
// `pnpm wasm:build` or the dev pipeline.
const fs = require('node:fs');
const path = require('node:path');

const src = require.resolve('@kikorin/engine-wasm/engine_bg.wasm');
const dest = path.join(__dirname, '..', 'public', 'engine_bg.wasm');

fs.copyFileSync(src, dest);
console.log(`copy-wasm: ${src} -> ${dest}`);
