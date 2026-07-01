## crates/pathfinding — NavMesh A* Pathfinder

### Purpose
Provides a 3D NavMesh with A* pathfinding for NPC navigation. Nodes are world-space positions; directed edges carry cost and jump/drop metadata. `find_path` returns a simplified waypoint list or `None` for unreachable targets.

### Boundaries
- **Owns:** `NavMesh`, `PathRequest`, `Waypoint`, `NavMeshConfig`, `NodeId`.
- **Must not:** import `crates/ecs`, `crates/physics`, or any ECS/engine crate. Pathfinding is stateless with respect to simulation state — callers supply start/goal positions.

### Inputs and Outputs
- **Inputs:** `NavMesh::new(config)`, `add_node(x, y, z) → NodeId`, `add_edge(from, to, cost, requires_jump, is_ledge_drop)`.
- **Query:** `find_path(PathRequest { start, goal, route_seed, can_jump, start_y }) → Option<Vec<Waypoint>>`.
- **Outputs:** `Waypoint { x, y, z, requires_jump, is_ledge_drop }` list, simplified by removing waypoints where the 3-D heading changes less than ~23°.

### PathRequest Fields
- `start` / `goal`: 3-D world positions `[x, y, z]`.
- `route_seed`: optional — adds deterministic noise (≤ 5% of edge cost) for route variety.
- `can_jump`: when `false`, edges with `requires_jump = true` are excluded. Monsters that cannot jump will route around them or receive `None` if no alternative path exists.
- `start_y`: optional floor Y of the entity. When set, start-node lookup uses 3-D distance (`nearest_walkable_3d`) to avoid anchoring to an elevated platform directly overhead that shares the same XZ cell.

### Invariants
- Returns `None` if either start or goal has no reachable node, or if A* finds no path (disconnected graph or all paths blocked by `can_jump = false`).
- `route_seed` produces routes within (1 + 5%) of optimal.
- Path simplification never removes jump or ledge-drop waypoints.
- Heuristic is 3-D Euclidean distance — admissible because edge costs are always ≥ straight-line 3-D distance between adjacent nodes.

### Dependencies
- `pathfinding` crate (A* implementation). No ECS, physics, or engine dependencies.

### Verification
- `cargo test -p pathfinding` — five tests:
  - `astar_finds_path_on_32x32_grid`: 20% random walls, path is non-empty when reachable.
  - `astar_returns_none_for_isolated_goal`: disconnected graph returns `None`.
  - `route_seed_produces_different_paths`: two seeds both find paths.
  - `can_jump_false_blocks_jump_only_path`: jump-only graph returns path with `can_jump=true`, `None` with `can_jump=false`.
  - `start_y_selects_correct_height_layer`: 3-D lookup anchors start to ground layer even when a platform node shares the same XZ.

### WASM Surface (crates/engine)
The engine crate exposes two WASM methods that delegate here:
- `build_navmesh()` — scans Rapier floor geometry to populate the `NavMesh`; call once after terrain is spawned.
- `find_path(startX, startY, startZ, goalX, goalZ, canJump)` — returns a `JsWaypoint[]` or `null`; `route_seed` is always `None` from the WASM surface (no detour routing via JS).

The TypeScript `EngineHandle` interface in `packages/adapter/src/types.ts` declares both methods so TypeScript callers are type-safe.

### Change Notes
- **v2:** 3-D heuristic (includes dy); `can_jump` field on `PathRequest` to exclude jump edges; `start_y` field for height-aware start-node lookup via `nearest_walkable_3d`; path simplification upgraded to 3-D direction vectors (y now participates in the heading-change check, so stair/ramp waypoints are no longer incorrectly pruned).
- **v3:** WASM surface documented above wired into the monster AI in `apps/web/src/app/kikorin.tsx`. Monsters replan when the player moves > 5 units, follow waypoints with stuck detection and jump impulses, and fall back to direct pursuit when no path is available.
