## crates/pathfinding — NavMesh, A*, Flow Fields, Key Routes

### Purpose
The layered-pathfinding toolbox: a NavMesh graph with A* (`find_path`), shared flow fields (one Dijkstra serving a whole crowd), and baked key routes ("the ground knows how to get to key places"). Stateless with respect to the simulation — callers supply positions and capabilities. No dependency on `ecs`, `physics`, or `engine`. Which tool runs when is the engine's dispatcher's job (see `specs/engine/README.md`); this crate only provides the tools.

Coordinates are a generic 3-tuple; nothing in this crate assumes 3-D. `crates/engine`'s 3-D `build_navmesh` populates it from an X/Z ground-plane scan, while its 2-D counterpart (`crates/engine/src/navmesh2d.rs`) pins `z` to a constant — grid bucketing, heuristics, flow fields, and simplification all degenerate correctly since every node shares the same `z`.

### The capability dimensions
Every query and derived structure filters edges by a capability tuple:
- `can_jump` — excludes `requires_jump` edges (as before).
- `can_sprint` — excludes `requires_sprint` edges: connections Tier-4 discovery proved reachable only with a sprint-speed approach (ADR 0011). A promoted sprint edge offered to a non-sprinter would strand it mid-air — the same bug class `can_jump` guards against (ADR 0006/0008/0010).

**The graph is a multigraph**: `upgrade_edge` (post-construction Tier-4 promotion) never merges requirements — a sprint discovery between nodes that already have a plain edge becomes a *parallel* edge. `find_path` filters per request, and waypoint metadata resolution is capability-filtered, picking the cheapest edge the searcher could actually have used — an unfiltered lookup could label a waypoint with a requirement the mover can't satisfy.

### Inputs and Outputs
- **Build:** `NavMesh::new(config)`, `add_node(x,y,z) → NodeId`, `add_edge(from, to, cost, requires_jump, is_ledge_drop)`. Config carries only `cell_size` (spatial-index bucket size); mesh bounds are wherever nodes are added.
- **Mutate:** `upgrade_edge(from, to, cost, requires_sprint)` — add or cost-improve a discovered jump connection (always jump-class; see multigraph note above). The engine applies these only at tick boundaries.
- **Query:** `find_path(PathRequest) → Option<Vec<Waypoint>>`; `nodes_within(x, z, radius)` (grid-indexed candidate window for discovery sweeps); `node_count` / `node_position` / `has_edge` accessors.
- **Snap window:** start/goal lookup scans ±2 grid cells (`SNAP_RADIUS_CELLS`); farther off-mesh returns `None` — "off-mesh", not "no route".

### PathRequest Fields
- `start` / `goal` — 3-D world positions.
- `can_jump` / `can_sprint` — capability filters (above).
- `start_y` — optional floor Y; switches start lookup to 3-D distance so ground-level movers don't anchor to a platform overhead.
- `route_seed` — optional deterministic noise (≤ 5 % of edge cost) for route variety.

### FlowField — one computation, whole-crowd reuse
`build_flow_field(goal, can_jump, can_sprint) → Option<FlowField>` (XZ goal snap, matching `find_path`) or `flow_field_to_node(node, …)` for an exact target. One **reverse Dijkstra** from the goal over the capability-filtered reversed graph yields, for every reachable node, a `FlowHop { to, requires_jump, requires_sprint, is_ledge_drop }` — the *forward* neighbor to move toward plus the edge metadata a follower needs for jump timing (this is what keeps the engine's tested jump machinery working for flow movers). Per-monster lookup is O(1) (`next_hop`, `distance`, `reaches`).
- One-way edges reverse correctly for free: a node only enterable by a ledge drop is simply unreachable in fields whose goal lies back up top — safe degrade, no special case.
- Costs accumulate in fixed-point `u64` (same `COST_SCALE` as A*); no route noise (a shared field must not desync).

### KeyRoutes — baked "the ground knows" routes (Tier 3)
- `derive_key_nodes()` — key nodes derived from geometry, never hand-tuned: square clusters sized for ~√(node count) buckets; representative = member nearest the bucket centroid. XZ-only bucketing (v1 tradeoff: stacked layers share a bucket; the Tier-2 fallback covers the loss).
- `build_key_routes(can_jump, can_sprint)` builds one flow field per key node — **a predecessor tree toward key k IS a flow field toward k**, so this reuses the flow machinery wholesale and the engine can build the K fields one per tick (`KeyRoutes::from_parts` reassembles).
- `plan(mesh, start, start_y, goal) → Option<KeyPlan>` — zero-search: pick the key nearest the goal that (a) is reachable from the start under this capability tuple and (b) is **meaningfully closer to the goal than the start already is** (the usefulness gate — a key that doesn't beat standing still returns `None`, which is also the implicit "this is a short haul, use plain A*" signal). Walk that key's field from the start node, simplify, return the waypoints plus `exit_key` for the caller's last-mile bridge search.

### Key Logic
- A* heuristic is 3-D Euclidean — admissible since edge cost ≥ straight-line distance.
- Waypoint simplification drops headings changing < ~23°; jump, sprint, and ledge-drop waypoints are never dropped.

### WASM Surface (via crates/engine)
- `build_navmesh()` / `build_navmesh_2d(...)` — populate the mesh (see `specs/engine/README.md`).
- `find_path(...)` — thin delegate; `can_sprint` is always false on this manual debug surface (sprint edges are for capability-tagged monsters).
- Flow fields, key routes, and edge promotion have no direct WASM surface — they're driven by the engine's dispatcher and heavy work queue internally.

### Dependencies
`pathfinding` crate (A*). No ECS/physics/engine deps.

### Verification
`cargo test -p pathfinding@0.1.0` (bare `-p pathfinding` is ambiguous with the external A* crate) — A* agrees with BFS ground truth on a random 32×32 maze; isolated-goal `None`; route-seed variety; `can_jump=false` blocks jump-only paths; jump metadata rides the destination waypoint; `start_y` height-layer selection; simplify collapses collinear waypoints but never jump waypoints. Flow fields: hops from every node reach the goal with strictly decreasing distance; wall detours; `can_jump`/`can_sprint` filtering leaves gated regions unreachable rather than misleading; one-way ledge drops degrade to unreachable on the return direction; hop metadata carries the jump flag. Key routes: derived key count scales with √V; plans end at the key nearest the goal; the no-reachable-key and not-closer-than-start cases return `None` for graceful Tier-2 fallback.
