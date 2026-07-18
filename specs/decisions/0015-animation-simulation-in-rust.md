# ADR 0015: Animation is Rust-simulated; TypeScript is a thin renderer

## Status
Accepted — Phase 1 implemented (`crates/animation`, the pure state machine).
Engine integration and authoritative combat are later phases (see Consequences).
Supersedes the resolver-ownership half of [ADR 0014](./0014-paperdoll-resolved-pose-contract.md).

## Context
ADR 0014 shipped paper-doll rendering with the *animation resolvers* (pose,
timing, frame selection) in TypeScript and only the discrete action *state*
planned to come from Rust. The follow-up requirement is a much richer animation
model: per-frame optimal/min/max timing, skippable frames, whole-animation
stretch/cut-short to fit a duration, interruptibility (block / queue / per-frame
cancel windows), transitions (loop / flow-to-next / hold-last), and per-frame
hit/hurtboxes that drive *real* combat.

That timing/fitting/interruption/hitbox logic is gameplay simulation, not
presentation — and it must react to events Rust already owns (jump mid-run, land,
sprint mid-landing). Under this project's ownership split (Rust owns canonical
simulation; TS owns rendering), it belongs in Rust. Keeping it in TS would fork
simulation across the boundary and make hit/hurtboxes non-authoritative.

## Decision
**Animation simulation moves into Rust; TypeScript becomes a thin renderer.**
Rust owns the whole animation state machine — playback clock, per-frame timing
and the stretch/cut fitting, transitions, interruptibility, and hit/hurtbox
geometry — and drives it off gameplay events. Each tick Rust emits the resolved
cell (frame + direction, later box activation) per entity; TS composites the art
and displays that cell, with an optional debug overlay of the boxes.

**A new pure `crates/animation`** holds the state machine, mirroring how
`pathfinding` is standalone: **no internal deps** (not even `ecs`). It defines
`AnimationSet` (families, per-frame `FrameSpec` timing/flags/boxes, transitions,
`Interrupt` policy, action→family map), `AnimationInstance` (per-entity playback:
`request`/`restart`/`advance`/`current_frame`), the `schedule_frames` time-fitting
function, and the yaw→direction quantizer (ported from the TS one, now the single
source). The engine owns the per-entity instances in its own map (like
`set_monster_goal`), so `ecs` never gains an animation column and stays Layer 0.

**Interruptibility is per-family policy + per-frame cancel windows**: `Always`
(locomotion), `Block`, `Queue` (defers the request to the family's end), plus any
frame flagged `cancelable` opens an interrupt window even under Block/Queue —
covering "block, queue, and cancel" together.

**Time-fitting is driven by Rust.** A family can be scheduled to a target
duration; `schedule_frames` shrinks flexible frames toward `min_ms`, then drops
`skippable` frames, or stretches toward `max_ms`, accepting an over/undershoot
when the flags can't reach the target. Rust picks the target from gameplay
(e.g. cut a run short into a jump).

**Boundary: extend `SemanticPatch`** with the resolved cell (`frame`, `dir`,
`anim`, later box activation) rather than a new patch slice — it already carries
per-entity gameplay state and merges latest-wins.

**Art/def split.** The *art* (sheets, cell size, layer order, direction rows)
stays in the TS `@kikorin/paperdoll` manifest. The *animation definition*
(timings, flags, transitions, boxes, action map) is game data loaded into the
engine — the sprite analog of `load_map(blocks)`. Rust never sees pixels.

## Consequences
- **Supersedes ADR 0014's resolver ownership.** The TS pose/timing resolvers,
  `setAction`, and auto-derived locomotion are replaced by Rust-driven cells
  (Phase 2 refactor). ADR 0014's other decisions stand: resolved-pose contract,
  `THREE.Sprite` renderer, full-sheet sRGB bake, `texture.offset` selection.
- **Touches black boxes when integrated**: `engine` (per-entity instances,
  `load_animations`, tick/event hooks), `patch` + `adapter` (SemanticPatch
  fields), and eventually the combat path. Requires `wasm:build` + committed
  `pkg/`. `crates/animation` itself is standalone and independently tested.
- **Authoritative hit/hurtboxes are a new melee-combat subsystem** (Phase 3),
  alongside the existing bullet system — the largest remaining piece.
- **Phasing**: (1) ✅ pure `crates/animation` core + cargo tests; (2) engine
  integration — instances, `load_animations`, tick fits/transitions off
  controller/physics events, emits the cell; TS refactored to display it;
  (3) authoritative boxes + melee combat + TS debug overlay.
- Direction quantization now lives in Rust; the TS `direction.ts` becomes
  vestigial once Phase 2 lands (the engine emits `dir`).

## Rejected alternatives
- **Keep resolvers in TS (ADR 0014 as-is)**: forks simulation across the
  boundary and can't make hit/hurtboxes authoritative. Rejected per the
  ownership split.
- **Animation state as an `ecs` component column**: would make `ecs` depend on
  animation types (or grow a bespoke column), breaking Layer 0. The engine's
  own per-entity map keeps `ecs` clean and `animation` reusable.
- **A dedicated `AnimationPatch` bundle slice**: more boundary plumbing than
  extending `SemanticPatch`, with no benefit at the current payload size.
