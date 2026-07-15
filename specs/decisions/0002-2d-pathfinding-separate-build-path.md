# ADR 0002: 2D pathfinding is a separate build path, not a dimension-branch of the 3D navmesh scan

## Status
Accepted

## Context
`crates/pathfinding`'s `NavMesh`/A* core turned out to already be dimension-agnostic — nodes are a plain `(x, y, z)` triple, the spatial grid buckets by `(x, z)`, and the heuristic/simplification math is generic 3-D Euclidean distance. Feeding it 2D positions as `(x, y, 0)` degenerates correctly with no changes to the crate.

The part that *is* 3D-specific is `crates/engine`'s `build_navmesh()`: it rasterizes the X/Z ground plane and, at each column, keeps only the **first** (topmost) walkable surface hit by a downward raycast (`walkable_height_at`). That's correct for outdoor 3D terrain, but wrong for a 2D side-view level where a platform floats directly above a full-width ground strip — both are independently walkable, and a naive port would make the ground underneath every platform invisible to the navmesh (confirmed as a real bug during design, not a hypothetical one — a `KIKORIN_2D_MAP`-shaped fixture reproduces it).

Also considered and rejected: a genuinely separate build algorithm for "monsters that can't jump," reasoning that a jump-agnostic mover needs a simpler graph. Rejected because `find_path`'s existing `can_jump: bool` already excludes jump-flagged edges at query time against one shared mesh — exactly how 3D already serves non-jumping movers. No second mesh needed.

## Decision
Add `crates/engine/src/navmesh2d.rs` as a **new, separate module** — not a 2D branch inside `build_navmesh`. It rasterizes X only (2D's ground plane is 1-D) and, at each column, collects **every** stacked walkable surface via repeated raycasting (reusing the existing `MAX_TERRAIN_LAYERS_PER_COLUMN` constant and `non_walkable_terrain` exclusion, both already dimension-agnostic) instead of stopping at the first hit.

Edge reachability is *computed*, not threshold-based: given the caller-supplied `MovementCapability2D` (walk speed, jump speed, jump count) and the engine's real gravity constant, `jump_reachable` solves actual projectile motion for each candidate gap — single-jump via the quadratic trajectory equation, multi-jump via an apex-chaining recursion (spend one jump to reach the previous jump's apex, recurse on the remaining gap) — rather than checking a fixed height-difference threshold the way 3D's `NavConfig` does. Sampling resolution is likewise derived from the scanned floor geometry's smallest block (`derive_scan_resolution`), not a fixed `cell_size`.

`build_navmesh_2d(walk_speed, jump_speed, max_jumps)` is a new WASM method, called explicitly by the 2D game once terrain is spawned (2D has no single `load_map`-style entry point to hook into). It stores into the same `self.navmesh` slot `build_navmesh` does, so `find_path` — including `can_jump: false` for grounded-only queries — works against a 2D-built mesh with **zero changes**.

## Consequences
- `build_navmesh` (3D) is completely untouched — an existing, tested black box, left alone per the project's black-box rules.
- `crates/pathfinding` itself needed zero code changes — confirmed reusable exactly as designed.
- The reachability model is a documented sufficient-condition heuristic (see `navmesh2d.rs`'s doc comments), not an exhaustive optimal-control solve — it may reject some gaps a cleverly-timed multi-jump could actually cross, but never claims a gap is reachable when it isn't. Right bias for a navmesh: a false "reachable" strands a mover mid-air.
- Monster jump *execution* doesn't yet support multi-jump (see [0003](./0003-2d-monster-ai-reuses-3d-code-via-z-zero.md)'s consequences) — the 2D game currently builds the mesh assuming single-jump capability even though the 2D player can double-jump, to match what monsters can actually execute.
