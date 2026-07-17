# ADR 0011: Layered pathfinding — tiered planners, shared flow fields, baked key routes, and Tier-4 discovery

## Status
Accepted

## Context
Until now there was exactly one pathfinding tier per dimension (3D grid A*, 2D physics-based navmesh), budgeted at one search per tick. Every situation paid the same kind of cost: one lone monster with a unique goal across the map, and fifty monsters all chasing the same player, each ran their own full A*. The user asked for a real stack — "varying levels of smartness," a master pathfinder that "uses fast ones while the slow ones compute," monsters that share what the smart tier discovers, and layered goals (ultimate/interim/reactive).

An adversarial design review before implementation surfaced one "broken as designed" finding and several load-bearing constraints; all are baked into what was built:
- **Sprint had to become a first-class capability.** Tier-4 discovery proves some gaps only clearable with a running start. Promoting those into the shared graph as plain jump edges would route ordinary walkers onto them — silently reintroducing the mid-air stranding bug class ADRs 0006/0008/0010 exist to prevent.
- **Flow fields must be keyed on fine navmesh nodes, never Tier-3 key nodes** — coarse keying could point a monster at the *wrong player* for as long as two players share one coarse cell.
- **The route representation needed a real data model, not a bolt-on field** — a flow field has no owned waypoints, and a spliced route is someone else's data with your own index.
- **Graph mutations only at tick boundaries**, never mid-iteration while other monsters read the same structure.
- **One budget boolean can't arbitrate three cost classes** — cheap searches, whole-mesh Dijkstra floods, and physics-solving sweeps needed separate lanes.

## Decision
**Four tiers, one toolbox (`crates/pathfinding`), one dispatcher (`crates/engine`).** Tier 1 = direct steering (exists: flying monsters, path-less fallback). Tier 2 = single-layer A* (exists, unchanged). Tier 3 = baked key routes: key nodes derived from geometry (~√V clusters, representative nearest centroid — never hand-placed), each with a precomputed flow field toward it; a query is zero-search (walk the field, one short bridge A* for the last mile). Tier 4 = the slow smart planner: `ballistic3d` generalizes `navmesh2d`'s real projectile solve to 3D (lateral distance `sqrt(dx²+dz²)` into the same 1D vertical solve — gravity only couples to Y) plus a sprint-speed launch variant.

**Tier 4 is a background *discoverer*, not a per-query planner.** It sweeps candidate node pairs on the heavy queue, and what it proves is promoted into the shared graph (`upgrade_edge`) — permanent terrain knowledge benefiting every future query by any capability-matched monster, with no per-monster async request lifecycle. Three probes gate acceptance, each covering a failure mode the pure math can't see: **arc clearance** (3D can have a pillar on the chord between two reachable-by-distance ledges — a failure mode 2D structurally lacked), **sprint runway** (clear run-up behind takeoff), and the **boring-pair filter** (`walkable_chord`) — found the hard way when the crowd integration test failed: without it, open floors carpet themselves in thousands of fake jump edges between trivially walkable pairs, and the perpetual promotion churn evicts the flow-field caches every tick. Promotions land only at tick boundaries; downstream caches (flow fields, key-route tables) rebuild.

**Sharing has two independent mechanisms.** (1) *Flow fields*: monsters on the default player chase share one reverse-Dijkstra field keyed `(fine goal node, can_jump, can_sprint)` — O(1) per monster per tick, no A* token; hops carry edge metadata (`FlowHop.requires_jump/…`) so the existing, tested jump-timing machinery drives flow movers unchanged. (2) *Route splicing*: A*/key-plan routes above a derived length pool as immutable `Rc` snapshots; a route-less monster near any pooled waypoint whose goal still matches (the existing `replan_stale_dist` staleness test, reused) snaps on and rides — only the first mover pays for a route several monsters need. The pool is deliberately not capability-keyed, so `find_splice` itself gates: a route demanding a jump or sprint the splicer lacks is never offered (found in post-implementation review — `follow_slice` trusts waypoints to be within the follower's capability, an assumption splicing was the first thing to break).

**Budget: two lanes.** The cheap lane is the existing one-A*-per-tick token (Tier-3 plans are zero-search and exempt). The heavy lane runs one resumable slice per tick — flow builds, key-route tables one field at a time, discovery by pair-count cursor — adaptively sized (`tune_slice`) from measured time toward 0.5 ms, no hardcoded work counts.

**Route shapes are a tagged enum** (`ActiveRoute::Owned/Spliced/Flow`) replacing `MonsterState.path + waypoint_index`; the follower core (`follow_slice`) operates on any waypoint slice with a caller-owned index, and exhaustion policy is per shape (walked-out Owned/Spliced earn an instant replan; failed searches keep their cooldown — the search-storm guard — and Flow just fetches a fresh hop).

**Goal layers**: concrete goals replace the target (override → closest player → fallback, unchanged); reactive influences only perturb velocity after the route picked a direction — `apply_monster_separation` was already this pattern; `add_monster_nudge` generalizes it.

`sprint_speed` is engine-global in `AiConfig` (like `jump_speed` — the mesh is solved for one canonical profile); `can_sprint` is per-monster in `MonsterCapability`. The "agile" template sprints by default so the discovery→promotion→execution pipeline is exercised in normal play.

## Consequences
- **Crowd cost collapsed**: N same-goal chasers now cost one Dijkstra (amortized on the heavy lane) plus N O(1) lookups, instead of N A* searches serialized through the one-per-tick token.
- **The mesh learns**: a promoted sprint edge is permanent map knowledge; monsters that can't use it are protected by the same capability filtering that already guarded `can_jump` — extended, not re-invented.
- **`crates/pathfinding`'s surface grew deliberately** (mutation, accessors, flow fields, key routes) — it remains ECS/physics-free; everything needing raycasts (arc/runway/chord probes) stays engine-side.
- **Known v1 tradeoffs**: key-node bucketing is XZ-only (stacked layers share a bucket; Tier-2 fallback covers it); a promotion flush transiently evicts flow fields (they rebuild on demand); key-route tables lag the live graph until their re-enqueued rebuild completes (lost opportunity, never a wrong route); `walkable_chord`'s ground probe has fixed 2.5-unit depth; the flow-field cache clears wholesale past 32 entries.
- **Zero-gravity engines (top-down) discover nothing** — `flight_time` has no solution — so the whole Tier-4 pipeline is inert there, by design rather than by gate.
