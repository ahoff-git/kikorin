## crates/pathfinding — NavMesh A* Pathfinder

### Purpose
A 3-D NavMesh with A* pathfinding for NPC navigation. Stateless with respect to the simulation — callers supply start/goal positions. No dependency on `ecs`, `physics`, or `engine`.

### Inputs and Outputs
- **Build:** `NavMesh::new(config)`, `add_node(x,y,z) → NodeId`, `add_edge(from, to, cost, requires_jump, is_ledge_drop)`. Config carries only `cell_size` (the spatial-index bucket size); mesh bounds are wherever nodes are added — the caller owns the sampling domain.
- **Query:** `find_path(PathRequest) → Option<Vec<Waypoint>>`. Returns `None` when start or goal snaps to no node, or the graph is disconnected under the request's constraints.
- **Snap window:** start/goal lookup scans only ±2 grid cells (`SNAP_RADIUS_CELLS`) around the query point — a query farther off-mesh returns `None` even if reachable nodes exist beyond the window. Callers must treat that as "off-mesh", not "no route".

### PathRequest Fields
- `start` / `goal` — 3-D world positions.
- `can_jump` — when `false`, edges with `requires_jump` are excluded; a monster that can't jump routes around them or gets `None`.
- `start_y` — optional floor Y of the entity. Switches start-node lookup to 3-D distance (`nearest_walkable_3d`) so it anchors to the ground layer instead of an elevated platform sharing the same XZ cell.
- `route_seed` — optional deterministic noise (≤ 5 % of edge cost) for route variety; always `None` from the WASM surface.

### Key Logic
- Heuristic is 3-D Euclidean distance — admissible because edge cost ≥ straight-line 3-D distance between adjacent nodes.
- Output waypoints are simplified by dropping any where the 3-D heading changes < ~23°. Jump and ledge-drop waypoints are never dropped, and Y participates in the heading check so stair/ramp waypoints survive.

### WASM Surface (via crates/engine)
- `build_navmesh()` — scans Rapier floor geometry to populate the mesh; run once after terrain spawn (invoked internally by `load_map`).
- `find_path(...)` — thin delegate returning `JsWaypoint[]` or `null`.

### Dependencies
`pathfinding` crate (A*). No ECS/physics/engine deps.

### Verification
`cargo test -p pathfinding@0.1.0` (bare `-p pathfinding` is ambiguous with the external A* crate) — A* agrees with BFS ground-truth reachability on a random 32×32 maze, isolated-goal `None`, route-seed variety (some seed diverges from baseline), `can_jump=false` blocks jump-only paths, jump metadata rides the destination waypoint, `start_y` height-layer selection, simplify collapses collinear waypoints but never drops jump waypoints.
