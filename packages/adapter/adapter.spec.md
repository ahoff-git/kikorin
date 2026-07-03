## packages/adapter — WASM Data Contract & Channels

### Purpose
Defines the TypeScript mirror types for the Rust `PatchBundle` and owns the five typed pub/sub channels that fan patch data out to Three.js, React UI, netcode, game logic, and metrics. Pure contract + routing — it drives no loop and interprets no data.

### Channels
`renderChannel` (`RenderPatch[]`), `hudChannel` (`SemanticPatch[]`), `netChannel` (`NetPatch[]`), `hitsChannel` (`HitPatch[]`), `metricsChannel` (`MetricsPatch`). A caller (`useEngine`) receives a `PatchBundle` from the worker and emits each slice onto its channel; consumers read channel snapshots.

### PatchBundle Type
```typescript
interface PatchBundle {
  tick: number;
  render: RenderPatch[];     // position + rotation, dirty entities only
  semantic: SemanticPatch[]; // health, net_flags, grounded
  net: NetPatch[];           // peer events, queued (never merged)
  hits: HitPatch[];          // bullet hit/expiry events, queued (never merged)
  metrics: MetricsPatch;     // tick_ms, ai_ms, physics_ms, pathfinding_ms, net_ms, patch_ms, boundary_ms
}
```
`metrics.boundary_ms` is absent on the raw WASM bundle; the worker fills it (observed `tick()` call time − Rust-internal `tick_ms`) before each flush, measuring the WASM-boundary conversion cost.

### Simulation / Render Cadence
The worker (`engineWorker.ts`) self-drives the Rust sim as fast as `setTimeout(fn, 0)` allows (~250 Hz), clamping each step's `dt` to 100 ms to avoid a spiral of death on tab refocus. Between flushes it accumulates patches — transforms/semantic merged per entity (latest wins), net patches queued — and posts a `PatchBundle` to the main thread every `FLUSH_INTERVAL_MS` (~16 ms). The RAF loop reads channel state per frame; `metricsChannel` fires per flush (~60 Hz), not per frame.

### Invariants
- `render` carries only entities dirtied since the last flush.
- `semantic` merges fields within a flush window so partial updates aren't lost.
- `net` and `hits` patches are events and are never merged.

### Dependencies
Consumed by `apps/web/src/app/useEngine.ts` (fan-out) and `packages/system-rendering` (render subscription).

### Verification
`pnpm --filter @kikorin/adapter test` — `channel.test.ts` verifies `Channel` delivers emissions to subscribers, respects unsubscribe, and returns the initial snapshot before first emission.
