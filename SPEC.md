# SPEC: Rust-WASM Game Engine — Next.js Integration

## Goal

A modular, data-driven Rust game engine compiled to WASM that lives inside a Next.js/TypeScript/React site. Rust owns the canonical simulation (ECS, physics, pathfinding, networking protocol, patch generation); TypeScript owns input, rendering, HUD, browser integration, and pub/sub fan-out. Components are modular enough to rip out and reuse alone, so small personal projects can drop in only the subsystems they need.

---

## Ownership Split

| Side | Owns |
|---|---|
| **Rust (`crates/`)** | Canonical ECS state, dirty tracking, system execution, Rapier physics, NavMesh A* pathfinding, peer delta protocol, monster AI / bullets, per-tick `PatchBundle` generation |
| **TypeScript (`packages/`, `apps/web`)** | User input, Three.js rendering, React HUD, WASM loading + worker hosting, adapter channel fan-out, batched consumer-side state updates, **game data** (map layout, tuning) |

TypeScript never writes engine state directly — all mutations go through the WASM API (spawn/destroy/velocity/input methods). The `PatchBundle` is the only per-tick data that crosses the boundary; there are no per-entity getter calls in the hot path.

The engine ships no game data: maps arrive as blocks via `load_map(blocks)` (navmesh bounds are derived from that geometry), and AI/navmesh tuning defaults are overridable via `set_ai_config` / `set_nav_config`. This is what lets other projects reuse the engine without forking it.

---

## Crate Layering

Dependency rule: a crate may depend on `ecs` (the shared substrate) and external crates — never on a sibling. Only `engine` assembles multiple crates.

```
Layer 2:  engine            (orchestrator; the only multi-crate importer)
Layer 1:  physics  netcode  patch     (each depends on ecs only)
Layer 0:  ecs  pathfinding            (no internal deps)
```

Consequences that keep the "rip one out" promise:
- `pathfinding` is fully standalone (no ecs/physics knowledge).
- `netcode` needs only `ecs` — no physics, pathfinding, or game loop comes along.
- `patch` owns the boundary payload schema (including the boundary `NetPatch`); `engine` maps netcode's wire-level patches into it, so the two crates stay independent.

Each crate compiles and passes its tests independently (`cargo test -p <crate>`).

---

## Data Flow (per tick)

1. Rust `Engine::tick(dt_ms)` runs the fixed system order (see [engine.spec.md](./crates/engine/engine.spec.md)) and returns a `PatchBundle` — render, semantic, net, and hit patches for dirty entities plus always-present metrics.
2. A dedicated Web Worker hosts the WASM engine, self-drives the sim in fixed 4 ms steps, and accumulates bundles between flushes (transforms/semantic merged per entity, net/hit events queued), posting one merged bundle to the main thread at ~60 Hz.
3. `useEngine` fans the bundle out onto typed pub/sub channels in `packages/adapter`: `renderChannel`, `hudChannel`, `netChannel`, `metricsChannel`, `hitsChannel`.
4. Consumers subscribe only to what they need: Three.js reads flat render patches, React HUD reads semantic state, debug tooling reads metrics. Raw engine state never floods React or Three.js.

---

## Cross-Cutting Contracts

### Performance metrics
Always emitted; consumers may ignore them. Coverage spans all layers:

| Domain | Metric | Measured in |
|---|---|---|
| Whole ECS loop | `tick_ms` | Rust |
| Engine systems (AI, separation, bullets, dirty marking) | `ai_ms` | Rust |
| Physics | `physics_ms` | Rust |
| Pathfinding (A* share of `ai_ms`) | `pathfinding_ms` | Rust |
| Networking (inbound apply + outbound flush) | `net_ms` | Rust |
| Patch generation | `patch_ms` | Rust |
| WASM boundary (JsValue conversion + call overhead) | `boundary_ms` | worker (observed call time − `tick_ms`) |
| Rendering pipeline | `frame_ms` EMA | `system-rendering` (`getRenderMetrics()`) |

### Logging
- Rust: `log::*` gated by `set_log_level(0–4)`; init at `warn`.
- TypeScript: `packages/util/src/logging.ts` — level-gated, keyword-filtered, off by default, toggleable at runtime.

### Serialization
Boundary hot path uses `serde-wasm-bindgen` (tick returns a JS object directly); peer wire payloads and entity blueprints use bincode. No JSON in hot paths.

---

## Constraints

- **No duplicated logic** between Rust and TypeScript: when a subsystem moves to Rust, the TS version is deleted, not maintained in parallel.
- **Modularity invariant**: the crate layering above; siblings never import each other.
- **TypeScript strict mode**: `strict: true`, no `any`, no `as unknown as X` casts.
- **No test mocks for engine state**: tests exercise real ECS/physics/pathfinding logic.
- **Subsystems that are not active** (e.g., no navmesh built) emit empty patch slices or `null`, never errors.
- **Dirty flags are cleared at end of tick**, after the patch is generated.

---

## Verification

- `cargo test --workspace` — unit tests per crate (ECS lifecycle + 10k-entity perf bound, physics contracts — gravity/grounded/velocity-split/queries/removal, A* pathing/route constraints, patch round-trip + emission rules, netcode delta round-trip, engine navmesh routing + derived bounds).
- `pnpm test` — adapter channel delivery, rendering registry/subscription, util suites.
- `pnpm typecheck` — zero errors, workspace-wide.
- `pnpm wasm:build` — wasm-pack build (`--target bundler`), renames pkg to `@kikorin/engine-wasm`, copies the binary to `apps/web/public/engine_bg.wasm`. This is the only command that requires the Rust toolchain: `crates/engine/pkg/` is committed, and the web build copies the binary from it into `public/` (`apps/web/scripts/copy-wasm.cjs`), so deploy environments (Vercel) build without Rust. After changing Rust code, run `pnpm wasm:build` and commit the regenerated `pkg/`.
- Modularity check: `cargo tree -p patch --depth 1` and `cargo tree -p netcode --depth 1` show no sibling deps beyond `ecs`.

---

## Mini Spec Index

Each black box has a colocated mini spec. [engine.spec.md](./crates/engine/engine.spec.md) is the top-level entry point; the others fill in per-box detail.

**Rust crates:**
- [Engine orchestrator (WASM entry point)](./crates/engine/engine.spec.md)
- [ECS world & scheduler](./crates/ecs/updateLoop.spec.md)
- [Physics world (Rapier3D)](./crates/physics/physics.spec.md)
- [Pathfinding (NavMesh A*)](./crates/pathfinding/pathfinding.spec.md)
- [Netcode peer delta tracker](./crates/netcode/peer.spec.md)
- [Patch bundle generation](./crates/patch/bundle.spec.md)

**TypeScript packages:**
- [Adapter — boundary types & channel fan-out](./packages/adapter/adapter.spec.md)
- [System-rendering — Three.js render bridge](./packages/system-rendering/rendering.spec.md)
