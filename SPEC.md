# SPEC: Rust-WASM Game Engine — Next.js Integration

---

## Goal

A modular Rust game engine compiled to WASM that owns simulation state (ECS, physics, pathfinding, networking, patch generation) and exposes it to a Next.js/TypeScript/React host via a typed diff/patch adapter layer — so multiple small projects can drop in only the subsystems they need.

---

## Explore First (Do This Before Writing Any Code)

1. Walk the existing JavaScript game engine codebase. Identify:
   - All files that implement ECS logic (component stores, system runners, entity managers)
   - All files that touch physics or collision
   - Any existing pathfinding or netcode
   - The current rendering pipeline and its data contract with the simulation layer
   - Any existing diff/patch or state-sync logic
2. List every cross-cutting concern: logging, metrics, timing, dirty-flag tracking.
3. Note which parts of the JS engine have test coverage and which do not.
4. Read `tsconfig.json`, `next.config.*`, and `package.json` to understand the project's module system, WASM loading approach (if any), and build pipeline.
5. Pause. Write a short summary of what you found. Then proceed to the plan step.

---

## Plan (Do This Before Writing Any Code)

Produce a flat file called `PLAN.md` in the repo root containing:
- A list of crates/modules you will create and what each one owns
- The exact Rust `pub` API surface for each module (trait names, structs, method signatures — no implementation yet)
- The TypeScript adapter contract: what the WASM boundary exports, what TypeScript imports
- The pub/sub channel names and payload shapes
- A migration strategy: which JS files get deleted, which get replaced, which stay

Get explicit approval before writing implementation code.

---

## Scope

### In Scope

| Layer | Files / Modules | Responsibility |
|---|---|---|
| `crates/ecs` | `world.rs`, `storage.rs`, `scheduler.rs` | Column-based component storage (SoA arrays), system execution order, dirty-flag tracking per component type |
| `crates/physics` | `collision.rs`, `rapier_bridge.rs` | Rapier integration; exposes `CollisionEvent` and `PhysicsState` snapshots |
| `crates/pathfinding` | `astar.rs`, `grid.rs` | A* on a tile grid; `PathRequest` → `PathResult` |
| `crates/netcode` | `peer.rs`, `protocol.rs` | WebRTC data-channel peer-to-peer via `web-sys`; message serialization (bincode); authoritative vs. predicted state separation |
| `crates/patch` | `diff.rs`, `bundle.rs` | Per-tick dirty scan → `PatchBundle` (bincode-serialized flat struct); version counter |
| `crates/engine` (orchestrator) | `lib.rs`, `tick.rs` | Assembles the above crates; exposes WASM-bindgen API: `tick(dt_ms: f64) -> Uint8Array`, `applyInput(payload: Uint8Array)`, `getMetrics() -> JsValue` |
| `packages/adapter` | `adapter.ts`, `channels.ts`, `consumers/` | Deserializes `PatchBundle`; fans out to typed pub/sub channels; batches React state updates via `useSyncExternalStore`; Three.js render-data channel |

### Out of Scope

- User input handling (stays in TypeScript)
- Three.js scene graph and draw calls (stays in TypeScript)
- React component tree (stays in TypeScript)
- Game-specific logic (maps, units, rules) — this is an engine, not a game
- Server-authoritative multiplayer (peer-to-peer only for now)
- Hot module replacement of Rust code at dev time

---

## Interfaces

### WASM Exports (Rust → TypeScript)
```
tick(dt_ms: f64) -> Uint8Array           // returns serialized PatchBundle
applyInput(payload: Uint8Array) -> void  // accepts serialized InputEvent
getMetrics() -> JsValue                  // JSON: { tick_ms, ecs_ms, physics_ms, net_ms, patch_ms }
setLogLevel(level: u8) -> void           // 0=off 1=error 2=warn 3=info 4=debug
```

### PatchBundle (Rust struct, bincode-serialized)
```rust
pub struct PatchBundle {
    pub tick: u64,
    pub render: Vec<RenderPatch>,      // position, rotation, scale per entity
    pub semantic: Vec<SemanticPatch>,  // health, state, team, etc.
    pub net: Vec<NetPatch>,            // peer events
    pub metrics: MetricsPatch,         // per-system timing
}
```

### TypeScript Adapter Channels
```typescript
renderChannel:   Channel<RenderPatch[]>    // Three.js subscribes here
hudChannel:      Channel<SemanticPatch[]>  // HUD / React UI subscribes here
netChannel:      Channel<NetPatch[]>       // netcode consumers
metricsChannel:  Channel<MetricsPatch>     // debug overlay / logging
```

Each `Channel<T>` is a minimal pub/sub: `subscribe(fn: (data: T) => void): () => void`.  
Consumers call `useSyncExternalStore` against their channel — no raw engine state reaches React directly.

---

## Constraints

- **No duplicated logic**: if collision detection exists in the JS engine, delete the JS version when the Rust version ships; do not maintain both.
- **Modularity invariant**: each crate must compile and pass its own tests independently. `crates/pathfinding` must not import `crates/physics`. Only `crates/engine` may import multiple crates.
- **Zero-copy WASM boundary where possible**: prefer `Uint8Array` + bincode over `JsValue` JSON for hot-path data.
- **Toggleable logging**: all `log::*` calls gated by the log level set via `setLogLevel`; default is `warn` in production builds, `debug` in dev.
- **Performance metrics on by default**: `MetricsPatch` is always emitted; consumers can ignore it but the data must exist.
- **TypeScript strict mode**: `strict: true`, no `any`, no `as unknown as X` casts.
- **No test mocks for engine state**: tests must exercise real ECS/physics/pathfinding logic, not mocked substitutes.
- **Style**: follow the existing project conventions visible in the codebase. Copy the shape of existing utility types and module layout, not the behavior.

---

## Pattern References

- Copy the module boundary shape from `[existing utility module in the JS engine]` — small default export, named type exports, no side effects at import time.
- Copy the React state pattern from `[existing hook or store in the project]` — `useSyncExternalStore` or equivalent; no prop-drilling engine state.
- For WASM loading, mirror the pattern in Next.js docs for `next/dynamic` with `ssr: false` — the engine must not attempt to load in SSR context.


---

## Invariants

- Rust owns canonical state. TypeScript never writes directly to engine state — all mutations go through `applyInput`.
- `PatchBundle` is the only thing that crosses the WASM boundary per tick. No per-entity `getX()` calls in the hot path.
- Dirty flags are cleared at the end of each tick after the patch is generated.
- Subsystems that are not instantiated (e.g., pathfinding disabled) emit empty patch slices, not errors.

---

## Verification (Acceptance Tests)

Run all of these before declaring the task done:

1. **Unit — ECS**: `cargo test -p ecs` passes. A world with 10,000 entities and two systems (position update, dirty-flag set) completes a tick in < 1ms on the CI machine.
2. **Unit — Physics**: `cargo test -p physics` passes. A sphere falling under gravity resolves a floor collision in ≤ 3 ticks.
3. **Unit — Pathfinding**: `cargo test -p pathfinding` passes. A* finds the shortest path on a 32×32 grid with 20% random walls; returns `None` for an unreachable target.
4. **Unit — Patch**: `cargo test -p patch` passes. A `PatchBundle` round-trips through bincode (serialize → deserialize → assert field equality).
5. **Integration — Adapter**: `pnpm test packages/adapter` passes. Feed a known `PatchBundle` binary into `AdapterEngine`; assert that `renderChannel` and `hudChannel` each receive the correct slices.
6. **Integration — WASM boundary**: a minimal Next.js page loads the WASM module, calls `tick(16.67)`, receives a `Uint8Array`, deserializes it in TypeScript, and logs entity count to console without errors.
7. **Build**: `cargo build --target wasm32-unknown-unknown --release` exits 0. `pnpm build` (Next.js) exits 0.
8. **Type check**: `pnpm tsc --noEmit` exits 0 with zero errors.
9. **Log toggle**: call `setLogLevel(0)`, run 100 ticks, assert no console output. Call `setLogLevel(4)`, run 1 tick, assert at least one log line.
10. **Modularity**: temporarily remove `crates/pathfinding` from `crates/engine/Cargo.toml`; confirm `cargo build -p ecs` and `cargo build -p physics` still succeed.

---

## Evidence to Return

When the task is complete, reply with:
- Output of `cargo test --workspace`
- Output of `pnpm tsc --noEmit`
- Output of `pnpm build`
- The public API surface of `crates/engine/src/lib.rs` (function signatures only, no bodies)
- The TypeScript type of `PatchBundle` as seen from the adapter layer

---

## Mini Spec Index

When any black box mini spec is created or updated, update this section to include links to the relevant mini spec files.

Rules:
- Use relative markdown links.
- Keep the list flat and scannable.
- Update links in the same pass when a mini spec is added, renamed, moved, or removed.
- If a task changes a black box and its mini spec, it must also update this section.
- Broken links are a task failure.

Black box review docs:

**Rust crates:**
- [ECS world & scheduler](./crates/ecs/updateLoop.spec.md)
- [Physics world (Rapier3D)](./crates/physics/physics.spec.md)
- [Pathfinding (NavMesh A*)](./crates/pathfinding/pathfinding.spec.md)
- [Netcode peer delta tracker](./crates/netcode/peer.spec.md)
- [Patch bundle generation](./crates/patch/bundle.spec.md)
- [Engine orchestrator (WASM entry point)](./crates/engine/engine.spec.md)

**TypeScript packages:**
- [Adapter — WASM bridge & channel fan-out](./packages/adapter/adapter.spec.md)
- [Engine facade (TS ECS + game loop)](./packages/engine/engine.spec.md)
- [Netcode — TypeScript P2P](./packages/netcode/netcode.spec.md)
- [System-flaginator — lazy flag evaluation](./packages/system-flaginator/flaginator.spec.md)
- [System-rendering — Three.js render bridge](./packages/system-rendering/rendering.spec.md)
- [System-entity-cleanup — destroy & fall cull](./packages/system-entity-cleanup/entityCleanup.spec.md)

---

## Evidence to Return

When the task is complete, reply with:
- Output of `cargo test --workspace`
- Output of `pnpm tsc --noEmit`
- Output of `pnpm build`
- The public API surface of `crates/engine/src/lib.rs` (function signatures only, no bodies)
- The TypeScript type of `PatchBundle` as seen from the adapter layer
- The updated `Mini Spec Index` entries in `SPEC.md`