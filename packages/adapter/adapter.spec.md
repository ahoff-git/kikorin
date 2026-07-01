## packages/adapter — WASM Bridge & Channel Fan-out

### Purpose
Defines the TypeScript types that mirror the Rust `PatchBundle` and owns the four typed pub/sub channels consumed by Three.js, React UI, netcode, and metrics. Does not drive any loop — the worker does.

### Boundaries
- **Owns:** channel definitions (`renderChannel`, `hudChannel`, `netChannel`, `metricsChannel`), and TypeScript mirror types for `PatchBundle` and related patch interfaces.
- **Must not:** own WASM module loading, React state, Three.js objects, or simulation timing. The adapter only defines the data contract and routing channels; it does not interpret or produce data.

### Inputs and Outputs
- **Inputs:** `PatchBundle` objects emitted by callers (e.g. `useEngine`) after receiving them from the worker.
- **Outputs:** Channel emissions — `renderChannel` (`RenderPatch[]`), `hudChannel` (`SemanticPatch[]`), `netChannel` (`NetPatch[]`), `metricsChannel` (`MetricsPatch`).

### TypeScript PatchBundle Type
```typescript
interface PatchBundle {
  tick: number;
  render: RenderPatch[];     // position + rotation per dirty entity
  semantic: SemanticPatch[]; // health, net_flags, grounded per dirty entity
  net: NetPatch[];            // peer events (queued, not merged)
  metrics: MetricsPatch;      // tick_ms, ecs_ms, physics_ms, net_ms, patch_ms
}
```

### Simulation / Render Cadence
- The worker (`engineWorker.ts`) runs the Rust simulation as fast as `setTimeout(fn, 0)` allows (~250 Hz).
- Between render flushes, patches accumulate in the worker: transforms and semantic state are merged per entity (latest wins); net patches are queued.
- The worker posts a `PatchBundle` to the main thread every ~16 ms (`FLUSH_INTERVAL_MS`).
- `useEngine` fans the bundle to the four channels; the RAF render loop reads channel state each frame.
- `metricsChannel` fires whenever a flush arrives (≈ 60 Hz), not every RAF frame.

### Invariants
- `render` patches contain only dirty entities since the last flush.
- `semantic` merges fields within a flush window so multiple partial updates for the same entity are not lost.
- `net` patches are events (peer joined/left); they are never merged.
- `dt` inside the worker is clamped to 100 ms per step to prevent spiral of death on tab focus restoration.

### Dependencies
- Consumed by `apps/web/src/app/useEngine.ts` (channel fan-out) and `packages/system-rendering` (render subscription).

### Verification
- `pnpm --filter @kikorin/adapter test` — `adapter.test.ts` feeds a known `PatchBundle` binary, asserts `renderChannel` and `hudChannel` subscriptions each receive the correct slices.

### Change Notes
- Decoupled simulation from RAF: the worker now self-drives via `setTimeout` and batches patches between flushes. `tick()` removed from `WorkerEngineProxy`; RAF loop simplified to `onFrame → renderFrame` only.
