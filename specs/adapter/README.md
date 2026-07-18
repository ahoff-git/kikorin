## packages/adapter — WASM Data Contract & Channels

### Purpose
Defines the TypeScript mirror types for the Rust `PatchBundle`, the shared boundary constants (the `NET_*` networking-profile bitmask — ownership/type/authority/predictability/urgency, mirroring `crates/ecs`; `EMPTY_METRICS`/`METRIC_FIELDS` as the single source for the metrics field list), and the five typed pub/sub channels that fan patch data out to Three.js, React UI, netcode, game logic, and metrics. Pure contract + routing — it drives no loop and interprets no data. Also mirrors the input contracts the game sends *into* the engine — the `*ConfigInput` tuning objects and `AnimationDefsInput` (families/timing/transitions for `load_animations`, the animation behavior half — see ADR 0015) — plus the `EngineHandle` method surface.

### Channels
`renderChannel` (`RenderPatch[]`), `hudChannel` (`SemanticPatch[]`), `netChannel` (`NetPatch[]`), `hitsChannel` (`HitPatch[]`), `lifecycleChannel` (`LifecyclePatch[]` — the game creates/removes local-entity meshes from these), `metricsChannel` (`MetricsPatch`). A caller (`useEngine`) receives a `PatchBundle` from the worker and emits each slice onto its channel; consumers apply state on emit (push) or read snapshots. `netChannel` carries remote-entity lifecycle events (`kind`: spawned/updated/despawned/peer_left, `entity` = local mirror id) — the game creates/removes remote meshes from it and `useNetworking` maintains the live peer list. `metricsChannel` currently has no standing subscriber — the HUD's TPS/tick-cost numbers are computed in `useEngine`'s bundle handler; the channel remains for debug overlays.

### PatchBundle Type
```typescript
interface PatchBundle {
  tick: number;
  render: RenderPatch[];     // position + rotation, dirty entities only
  semantic: SemanticPatch[]; // health, net_flags, grounded, + anim cell (anim_id/anim_frame/anim_dir)
  net: NetPatch[];           // peer events, queued (never merged)
  hits: HitPatch[];          // bullet hit/expiry events, queued (never merged)
  metrics: MetricsPatch;     // tick_ms, ai_ms, physics_ms, pathfinding_ms, net_ms, patch_ms, boundary_ms
}
```
`metrics.boundary_ms` is absent on the raw WASM bundle; the worker fills it (observed `tick()` call time − Rust-internal `tick_ms`) before each flush, measuring the WASM-boundary conversion cost.

### Simulation / Render Cadence
The worker (`engineWorker.ts`) self-drives the Rust sim with a fixed-step accumulator: `setTimeout(fn, 0)` pumps run up to `MAX_CATCHUP_STEPS` (8) ticks of exactly `SIM_STEP_MS` (4 ms) each — the engine never sees a variable dt, and time beyond the catch-up cap is dropped rather than fed to physics as a spike. Between flushes the worker accumulates patches — transforms/semantic merged per entity (latest wins), net/hit patches queued — and posts a `PatchBundle` to the main thread every `FLUSH_INTERVAL_MS` (~16 ms). Channel consumers apply patches on emit (push); the RAF loop only draws.

### Invariants
- `render` carries only entities dirtied since the last flush.
- `semantic` merges fields within a flush window so partial updates aren't lost.
- `net` and `hits` patches are events and are never merged.

### Dependencies
Consumed by `apps/web/src/app/useEngine.ts` (fan-out) and `packages/system-rendering` (render subscription).

### Verification
`pnpm --filter @kikorin/adapter test` — `channel.test.ts` verifies `Channel` delivers emissions to all subscribers (including multiple at once), respects unsubscribe, and returns the initial snapshot before first emission.
