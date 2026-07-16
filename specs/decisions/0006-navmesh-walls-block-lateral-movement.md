# ADR 0006: 3D navmesh walls block lateral movement, not just standing on top

## Status
Accepted

## Context
The top-down game's maze ([0005](./0005-topdown-game-reuses-3d-pipeline-with-zero-gravity.md)) is the 3D navmesh's first consumer with walls that stand directly on a walkable floor and separate two open, coplanar areas — every prior 3D map used walls only as knee-high parapets at the edge of a platform, or as full room boundaries with no walkable floor on the far side to reach at all. That difference exposed a real gap once monsters started actually trying to route through the maze: they walked straight through walls instead of using the doorways.

`walkable_height_at`'s column scan (per-XZ-cell, straight down) was built to solve a different problem: a cell whose column passes through a parapet's top should get its navmesh node on the platform *underneath* the parapet, not an unreachable node on the parapet itself. It did this by skipping past any non-walkable hit and continuing the scan below it. For a maze wall sitting flush on a floor, this produced a walkable node — at floor height, zero height difference from every neighbor — sitting **inside the wall's own footprint**, invisibly connecting the two sides it was supposed to separate.

The fix has two parts, and both were needed — either alone reintroduces the bug for a different wall thickness/alignment:
1. **Node placement**: a wall thinner than `NavConfig::cell_size` (1.5) can fall entirely between two neighboring grid nodes without covering either sample point — no phantom node is ever created, so excluding wall-footprint nodes alone doesn't help.
2. **Edge placement**: even with wall-footprint nodes excluded, two nodes that happen to straddle a thin wall are still ordinary same-height grid neighbors unless something explicitly checks the space between them.

The first fix attempt — stopping node placement dead on any non-walkable hit, applied everywhere — was validated against the *existing* `goal_beside_parapet_wall_stays_reachable` test, which deliberately queries a goal position hugging (inside the X-range of) a parapet's own footprint. That test still passed: `nearest_walkable`'s snap radius picks up the nearest real node just outside the parapet instead. The second fix — `horizontally_blocked`, a short raycast between candidate node positions just above the higher one's height, rejecting the edge if a non-walkable entity's collider is in the way — was probed above both nodes' own height specifically so a legitimate step-up/stair edge (whose riser tops out at the tread's own height) is never mistaken for a wall.

## Decision
`walkable_height_at` now returns `None` outright the instant its downward scan hits a non-walkable **floor** entity — no fallback to whatever's underneath it. (Non-floor entities transiently occupying a column — not walls — are still skipped past unchanged, since removing a real node just because a dynamic entity happened to be standing there at build time would be wrong.) A goal or AI query that lands on a wall's own footprint resolves through `nearest_walkable`'s existing snap-radius fallback instead of a phantom on-the-wall node.

`build_navmesh`'s edge-building loop gained `horizontally_blocked(from, to)`: before adding *any* edge (cardinal or diagonal), it casts a ray between the two candidate node positions at `WALL_PROBE_CLEARANCE` above the taller one, and skips the edge if the ray hits an entity in `non_walkable_terrain`.

`kikorinTopDownMap.ts`'s maze itself also needed a real fix, found while verifying the navmesh change in-browser: its four corner rooms had a doorway toward the center hub but none toward either adjacent edge room, making them entirely unreachable regardless of navmesh correctness — a map design gap the old, wall-ignoring navmesh had silently masked. Every partition run now gets its own doorway in addition to the hub's, via a shared `splitPartition` helper.

## Consequences
- **Any future 3D map with a wall standing on open, coplanar walkable floor on both sides now gets correct lateral blocking automatically** — no per-map opt-in, no new engine API. This was previously only correct by accident (every existing map's walls happened to be either parapets or boundary walls with nothing walkable beyond them).
- `walkable_height_at`'s "skip past and use what's underneath" behavior is now reserved for non-floor entities only. A future feature that stacks non-walkable *floor* terrain multiple layers deep in one column (not the parapet-on-platform case, which this still handles) would need revisiting.
- `horizontally_blocked` only checks entities in `non_walkable_terrain` — a horizontal obstruction from *walkable* terrain (e.g. a tall walkable pillar's side face) is not detected. Not needed by any current map; would need its own fix if that ever changes.
- This is a case where fixing a masked bug (the navmesh) surfaced a second, independent bug (the map). Both needed fixing together for the reported symptom ("monsters don't path around walls") to actually resolve — the navmesh fix alone left every corner room correctly *disconnected but unreachable*, not correctly *reachable via a detour*.
