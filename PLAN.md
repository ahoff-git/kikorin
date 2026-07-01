# PLAN: Rust-WASM Engine Migration

---

## Exploration Summary

The existing kikorin engine is a well-modularized TypeScript monorepo:

- **ECS**: bitECS with column-based TypedArrays. Components: Position, Velocity, Rotation, NetFlags, Collider, Gravity, Floor, Health, Render, Player. World in `packages/engine/src/core.ts`.
- **Physics**: Rapier3D (JS compat) in `packages/system-physics/`. Collision, gravity, floor detection, bounce suggestions, swept collider casts, ray casts.
- **Pathfinding**: A* with MinHeap in `packages/system-pathfinding/`. NavMesh with directed edges, jump/ledge-drop metadata, route seeding, path simplification.
- **Netcode**: PeerJS-based P2P in `packages/netcode/`. Binary protocol (8-byte header), ChangeTracker for delta generation, InterestGroups for pub/sub routing, lead election.
- **Rendering**: Three.js in `packages/system-rendering/`. Reads dirty-flag lists set by movement/collision systems; updates Object3D transforms. Separate world tick (60fps) and render tick (RAF).
- **State sync**: RenderDirtyFlags and CollisionDirtyFlags as packed arrays in core.ts. ChangeTracker in netcode uses a `Set<EntityId>` dirty set with per-component snapshot comparison.
- **Logging**: `packages/util/src/logging.ts` — level-gated, keyword-filtered, disabled by default.
- **Tests**: Vitest in most packages. Pathfinding has zero tests. Netcode has 5 test files.
- **Build**: pnpm@10.18.3, turbo, no WASM config currently.

---

## Crates to Create

| Crate | Path | Owns |
|---|---|---|
| `ecs` | `crates/ecs` | SoA component storage, entity lifecycle, system scheduler, dirty-flag tracking |
| `physics` | `crates/physics` | Rapier3D bridge, CollisionEvent, floor detection, gravity, bounce suggestions, ray/sweep casts |
| `pathfinding` | `crates/pathfinding` | NavMesh, A* with MinHeap, waypoint output, path simplification |
| `netcode` | `crates/netcode` | Binary message protocol, delta generation, state snapshot comparison |
| `patch` | `crates/patch` | Per-tick dirty scan → PatchBundle, bincode serialization, version counter |
| `engine` | `crates/engine` | Orchestrator; WASM-bindgen API surface only |

`crates/engine` is the only crate that imports multiple sibling crates. Siblings do not import each other.

---

## Rust `pub` API Surface

### `crates/ecs`

```rust
pub type EntityId = u32;

pub struct World { /* private */ }

impl World {
    pub fn new(capacity: usize) -> Self;
    pub fn create_entity(&mut self) -> EntityId;
    pub fn destroy_entity(&mut self, id: EntityId);
    pub fn tick_count(&self) -> u64;
    pub fn advance_tick(&mut self);
    pub fn entities(&self) -> impl Iterator<Item = EntityId> + '_;

    // Component accessors — None when component not present
    pub fn position(&self, id: EntityId) -> Option<[f32; 3]>;
    pub fn set_position(&mut self, id: EntityId, xyz: [f32; 3]);
    pub fn velocity(&self, id: EntityId) -> Option<[f32; 3]>;
    pub fn set_velocity(&mut self, id: EntityId, xyz: [f32; 3]);
    pub fn rotation(&self, id: EntityId) -> Option<[f32; 3]>; // [yaw, pitch, roll]
    pub fn set_rotation(&mut self, id: EntityId, ypr: [f32; 3]);
    pub fn health(&self, id: EntityId) -> Option<i32>;
    pub fn set_health(&mut self, id: EntityId, hp: i32);
    pub fn net_flags(&self, id: EntityId) -> Option<u8>;
    pub fn set_net_flags(&mut self, id: EntityId, flags: u8);
    pub fn collider(&self, id: EntityId) -> Option<ColliderConfig>;
    pub fn set_collider(&mut self, id: EntityId, cfg: ColliderConfig);
    pub fn is_grounded(&self, id: EntityId) -> Option<bool>;
    pub fn set_grounded(&mut self, id: EntityId, grounded: bool);
    pub fn is_floor(&self, id: EntityId) -> bool;
    pub fn set_floor(&mut self, id: EntityId, floor: bool);

    // Dirty-flag tracking — cleared at end of each tick after patch generation
    pub fn mark_dirty(&mut self, id: EntityId, flags: DirtyFlags);
    pub fn dirty_flags(&self, id: EntityId) -> DirtyFlags;
    pub fn dirty_entities(&self) -> impl Iterator<Item = EntityId> + '_;
    pub fn clear_dirty(&mut self);
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ColliderConfig {
    pub active: bool,
    pub sensor: bool,
    pub half_width: f32,
    pub half_height: f32,
    pub half_depth: f32,
}

bitflags::bitflags! {
    #[derive(Clone, Copy, Debug, Default)]
    pub struct DirtyFlags: u8 {
        const TRANSFORM = 0b0001;
        const COLLIDER  = 0b0010;
        const HEALTH    = 0b0100;
        const NET       = 0b1000;
    }
}

pub struct SystemScheduler { /* private */ }

impl SystemScheduler {
    pub fn new() -> Self;
    pub fn register(&mut self, name: &'static str, system: impl FnMut(&mut World, f32) + 'static);
    pub fn run(&mut self, world: &mut World, dt_secs: f32);
}
```

### `crates/physics`

```rust
pub struct PhysicsWorld { /* wraps rapier3d */ }

#[derive(Clone, Debug)]
pub struct CollisionEvent {
    pub entity_a: EntityId,
    pub entity_b: EntityId,
    pub kind: CollisionKind,
}

#[derive(Clone, Copy, Debug)]
pub enum CollisionKind { Started, Stopped }

#[derive(Clone, Debug)]
pub struct BounceSuggestion {
    pub entity: EntityId,
    pub normal: [f32; 3],
}

impl PhysicsWorld {
    pub fn new(gravity: f32) -> Self;
    pub fn sync_from_world(&mut self, world: &World);
    pub fn step(&mut self, dt_secs: f32) -> Vec<CollisionEvent>;
    pub fn sync_to_world(&self, world: &mut World);
    pub fn floor_height_at(&self, x: f32, z: f32) -> Option<f32>;
    pub fn touching(&self, entity: EntityId) -> &[EntityId];
    pub fn cast_collider(
        &self,
        entity: EntityId,
        world: &World,
        direction: [f32; 3],
        max_toi: f32,
    ) -> Option<BounceSuggestion>;
    pub fn cast_ray(&self, from: [f32; 3], to: [f32; 3]) -> Option<(EntityId, f32)>;
}
```

### `crates/pathfinding`

```rust
pub type NodeId = u32;

pub struct NavMesh { /* private */ }

pub struct NavMeshConfig {
    pub cell_size: f32,
    pub min_x: f32, pub max_x: f32,
    pub min_z: f32, pub max_z: f32,
}

#[derive(Clone, Debug)]
pub struct Waypoint {
    pub x: f32, pub y: f32, pub z: f32,
    pub requires_jump: bool,
    pub is_ledge_drop: bool,
}

pub struct PathRequest {
    pub start: [f32; 3],
    pub goal: [f32; 3],
    pub route_seed: Option<u32>,
}

impl NavMesh {
    pub fn new(config: NavMeshConfig) -> Self;
    pub fn add_node(&mut self, x: f32, y: f32, z: f32) -> NodeId;
    pub fn add_edge(
        &mut self,
        from: NodeId,
        to: NodeId,
        cost: f32,
        requires_jump: bool,
        is_ledge_drop: bool,
    );
    pub fn nearest_walkable(&self, x: f32, z: f32) -> Option<NodeId>;
    pub fn find_path(&self, req: PathRequest) -> Option<Vec<Waypoint>>;
}
```

### `crates/netcode`

```rust
pub struct DeltaTracker { /* private */ }

#[derive(Clone, bincode::Encode, bincode::Decode)]
pub struct NetPatch {
    pub peer_id: String,
    pub entity: u32,
    pub kind: NetEventKind,
}

#[derive(Clone, bincode::Encode, bincode::Decode)]
pub enum NetEventKind {
    Connected,
    Disconnected,
    DeltaUpdate { fields: Vec<FieldUpdate> },
    FullSync    { fields: Vec<FieldUpdate> },
    GameEvent   { payload: Vec<u8> },
}

#[derive(Clone, bincode::Encode, bincode::Decode)]
pub struct FieldUpdate {
    pub component_id: u8,
    pub field_id: u8,
    pub value: f64,
}

impl DeltaTracker {
    pub fn new() -> Self;
    pub fn mark_dirty(&mut self, entity: EntityId);
    pub fn flush(&mut self, world: &World) -> Vec<NetPatch>;
    pub fn full_snapshot(&mut self, world: &World) -> Vec<NetPatch>;
    pub fn apply_inbound(&mut self, payload: &[u8]) -> Result<Vec<NetPatch>, bincode::error::DecodeError>;
}
```

### `crates/patch`

```rust
#[derive(Clone, bincode::Encode, bincode::Decode)]
pub struct PatchBundle {
    pub tick: u64,
    pub render: Vec<RenderPatch>,
    pub semantic: Vec<SemanticPatch>,
    pub net: Vec<NetPatch>,
    pub metrics: MetricsPatch,
}

#[derive(Clone, bincode::Encode, bincode::Decode)]
pub struct RenderPatch {
    pub entity: u32,
    pub x: f32, pub y: f32, pub z: f32,
    pub yaw: f32, pub pitch: f32, pub roll: f32,
}

#[derive(Clone, bincode::Encode, bincode::Decode)]
pub struct SemanticPatch {
    pub entity: u32,
    pub health: Option<i32>,
    pub net_flags: Option<u8>,
    pub grounded: Option<bool>,
}

#[derive(Clone, bincode::Encode, bincode::Decode)]
pub struct MetricsPatch {
    pub tick_ms: f32,
    pub ecs_ms: f32,
    pub physics_ms: f32,
    pub net_ms: f32,
    pub patch_ms: f32,
}

pub struct PatchGenerator { /* private */ }

impl PatchGenerator {
    pub fn new() -> Self;
    pub fn generate(
        &mut self,
        world: &World,
        net: Vec<NetPatch>,
        metrics: MetricsPatch,
    ) -> PatchBundle;
    pub fn serialize(bundle: &PatchBundle) -> Vec<u8>;
    pub fn deserialize(bytes: &[u8]) -> Result<PatchBundle, bincode::error::DecodeError>;
}
```

### `crates/engine` (WASM-bindgen API)

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Engine { /* private */ }

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine;
    pub fn tick(&mut self, dt_ms: f64) -> Vec<u8>;         // → serialized PatchBundle
    pub fn apply_input(&mut self, payload: &[u8]);          // ← serialized InputEvent
    pub fn get_metrics(&self) -> JsValue;                   // JSON MetricsPatch
    pub fn set_log_level(&mut self, level: u8);             // 0=off … 4=debug
}
```

---

## TypeScript Adapter Contract

### `packages/adapter/src/types.ts`

```typescript
export interface RenderPatch {
  entity: number;
  x: number; y: number; z: number;
  yaw: number; pitch: number; roll: number;
}

export interface SemanticPatch {
  entity: number;
  health?: number;
  netFlags?: number;
  grounded?: boolean;
}

export interface NetPatch {
  peerId: string;
  entity: number;
  kind: NetEventKind;
}

export type NetEventKind =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'deltaUpdate'; fields: FieldUpdate[] }
  | { type: 'fullSync';    fields: FieldUpdate[] }
  | { type: 'gameEvent';  payload: Uint8Array };

export interface FieldUpdate { componentId: number; fieldId: number; value: number; }

export interface MetricsPatch {
  tickMs: number; ecsMs: number; physicsMs: number; netMs: number; patchMs: number;
}

export interface PatchBundle {
  tick: number;
  render: RenderPatch[];
  semantic: SemanticPatch[];
  net: NetPatch[];
  metrics: MetricsPatch;
}
```

### `packages/adapter/src/channels.ts`

```typescript
export interface Channel<T> {
  subscribe(fn: (data: T) => void): () => void;
  snapshot(): T;
}

export declare const renderChannel:  Channel<RenderPatch[]>;
export declare const hudChannel:     Channel<SemanticPatch[]>;
export declare const netChannel:     Channel<NetPatch[]>;
export declare const metricsChannel: Channel<MetricsPatch>;
```

### WASM loading (Next.js)

```typescript
// apps/web/src/lib/engine.ts
import dynamic from 'next/dynamic';
// Engine loaded via next/dynamic with { ssr: false }
// wasm-pack output imported as ES module
```

---

## Pub/Sub Channels

| Channel | Payload | Primary consumer |
|---|---|---|
| `renderChannel` | `RenderPatch[]` | `dirtyTransforms.ts` (Three.js transform update) |
| `hudChannel` | `SemanticPatch[]` | `uiBridge.ts` (React HUD) |
| `netChannel` | `NetPatch[]` | `useNetworking.ts` (WebRTC send) |
| `metricsChannel` | `MetricsPatch` | debug overlay / logger |

---

## Migration Strategy

### DELETE (replaced by Rust)

| File | Replaced by |
|---|---|
| `packages/system-physics/src/collision.ts` | `crates/physics` |
| `packages/system-physics/src/colliderUtils.ts` | `crates/physics` |
| `packages/system-physics/src/gravity.ts` | `crates/physics` |
| `packages/system-physics/src/collisionBounce.ts` | `crates/physics` |
| `packages/system-pathfinding/src/astar.ts` | `crates/pathfinding` |
| `packages/system-pathfinding/src/navmesh.ts` | `crates/pathfinding` |
| `packages/system-movement/src/movement.ts` | `crates/ecs` movement system |
| `packages/system-movement/src/transforms.ts` | `crates/ecs` dirty-flag tracking |
| `packages/netcode/src/change-tracker.ts` | `crates/netcode` DeltaTracker |
| `packages/ecs/src/types.ts` (component defs) | `crates/ecs` component storage |
| `packages/engine/src/entities.ts` | `crates/engine` applyInput + spawn |

### REWIRE (TS stays, data source changes to adapter channels)

| File | Change |
|---|---|
| `packages/system-rendering/src/dirtyTransforms.ts` | Subscribe to `renderChannel` instead of reading RenderDirtyFlags |
| `packages/system-ui-bridge/src/uiBridge.ts` | Subscribe to `hudChannel` instead of reading ECS directly |
| `apps/web/src/app/useNetworking.ts` | Subscribe to `netChannel` instead of direct PeerNet delta |
| `packages/engine/src/core.ts` (tick loop) | Replace world tick with adapter tick driver |

### KEEP (no changes)

| File | Reason |
|---|---|
| `packages/system-rendering/src/render.ts` | Three.js stays |
| `packages/system-controls/` | Browser input stays |
| `packages/system-commands/` | Command queue stays |
| `packages/system-flaginator/` | Reactive flags stay (reads from channels post-migration) |
| `packages/events/src/eventBus.ts` | Event bus stays |
| `packages/util/` | All utilities stay |
| `packages/netcode/src/peer-net.ts` | WebRTC transport stays (only delta encoding moves to Rust) |
| `packages/engine/src/cameraFollow.ts` | Camera stays |
| `packages/system-time/` | Timing/scheduling stays |
| `apps/web/` | Next.js app stays |

---

## Implementation Order

1. Cargo workspace scaffold (`Cargo.toml`, `crates/` directory)
2. `crates/ecs` — component storage + scheduler + dirty flags + unit tests
3. `crates/pathfinding` — A* port from TS + tests (no external crate deps)
4. `crates/physics` — Rapier3D bridge + gravity + tests
5. `crates/netcode` — DeltaTracker + message protocol + tests
6. `crates/patch` — PatchBundle + bincode round-trip + tests
7. `crates/engine` — orchestrator + wasm-bindgen surface + integration test
8. `packages/adapter` — TS bincode reader + channel fan-out + unit tests
9. Wire adapter into `apps/web/` (dynamic WASM load, replace engine hook)
10. Rewire `dirtyTransforms`, `uiBridge`, `useNetworking` to adapter channels
11. Delete replaced JS files
12. Run full verification suite

---

## Key Technical Decisions

- **bincode v2** for all serialization — faster than JSON, no schema overhead at the boundary
- **wasm-pack** (`wasm-pack build --target web`) for WASM compilation
- **rapier3d** crate directly (not the JS compat shim) for physics in WASM
- **`bitflags`** crate for DirtyFlags
- **`log` + `console_log`** crates for toggleable logging, matching the existing `logging.ts` level conventions (0=off, 1=error, 2=warn, 3=info, 4=debug)
- **WebRTC transport stays in TS** — `crates/netcode` handles encoding/delta only; PeerNet passes raw bytes through `applyInput`
- **`next/dynamic` with `ssr: false`** for WASM loading — engine must not attempt SSR
- **Dirty flags cleared after patch generation** — end of each tick, before next tick starts
