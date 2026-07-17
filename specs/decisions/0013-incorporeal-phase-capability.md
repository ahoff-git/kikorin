# ADR 0013: Incorporeal (can_phase) — collision groups + phase edges

## Status
Accepted

## Context
Feature request: an incorporeal flag letting things run through walls, with pathing support. Two halves, matching the two things a wall does: physically block, and sever the navmesh.

## Decision
**Physics**: walls get their own collision group (GROUP_3; ordinary floors GROUP_1, dynamics GROUP_2 — extending the existing groups documented in specs/physics). A phasing body's filter simply omits GROUP_3: it passes through walls but still stands on floors. `PhysicsWorld::set_wall(id, bool)` (driven by `walkable: false` at `load_map` and by `set_terrain_walkable`) and `set_phasing(id, bool)` (driven by `set_monster_capability`'s `can_phase`), duplicated per backend per ADR 0001. Raycasts ignore groups — bullets and probes still treat walls as solid.

**Pathing**: `can_phase` is the third capability dimension, threaded exactly like `can_jump`/`can_sprint` (PathRequest/Edge/Waypoint/FlowHop, flow fields, key routes, splice gate, capability tuples). Where `horizontally_blocked` severs a near-level neighbor pair at build time, the connection is kept as a `requires_phase` edge instead of dropped — a ghost's A*/flow route goes straight through the wall. Execution needs no new action: the wall simply doesn't collide.

**Discovery correctness**: phase edges must not make wall pairs look connected — the Tier-4 sweep uses non-phase variants (`non_phase_degree`/`has_non_phase_edge`/`non_phase_targets`) for frontier detection, pair skipping, and the detour-ratio Dijkstra.

The "ghost" monster template (grey, slower, `can_phase`) exercises it in normal play.

## Consequences
- Wall-vault discovery and phase edges coexist on the same pair as parallel edges with different requirements (the ADR 0011 multigraph pattern).
- Phasing is monsters-only today (capability-driven); a phasing *player* would just need the same `set_phasing` call.
- 2D's navmesh doesn't generate phase edges (its walls exclude nodes rather than sever edges) — `can_phase` is physics-only there.
