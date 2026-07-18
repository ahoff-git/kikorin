# crates/animation — Animation State Machine

> **Status: Phase 2 — integrated into the engine.** The pure state machine
> (this crate) is wired into `crates/engine`: the engine holds a per-entity
> `AnimationInstance` map, `load_animations` builds the set from game data, the
> tick advances each instance and emits the resolved cell on `SemanticPatch`,
> and the top-down game renders it (idle/walk derived from velocity, attack from
> `player_fire`). Still pending (Phase 3): authoritative hit/hurtbox combat
> (geometry is carried but unused). See [ADR 0015](../decisions/0015-animation-simulation-in-rust.md)
> and [ADR 0016](../decisions/0016-animation-branch-frames-and-collider-boxes.md).

## Purpose
Owns the animation *simulation*: given a set of animation families and a stream
of action requests plus `dt`, it decides which family/frame/direction an entity
shows, how the timeline stretches or is cut short to fit a duration, and when a
new action may interrupt the current one. Pure logic — the engine owns per-entity
instances and feeds this crate; TypeScript only renders the resolved cell.

## Boundaries
- **Owns**: the family/frame data model, per-frame time-fitting, playback +
  transitions (loop / next / hold-last), interruptibility, the action→family
  map, and the yaw→direction quantizer (the single source; TS no longer computes
  direction once the engine emits it).
- **Does not**: touch the ECS `World`, the engine, physics, or rendering; ship or
  interpret art (sheets/pixels live in the TS `@kikorin/paperdoll` manifest);
  own combat — hit/hurtbox geometry is carried as data, but consuming it for
  damage is the engine's job (a later phase). Standalone like `pathfinding`: **no
  internal deps** (not even `ecs`), so the engine holds instances in its own
  per-entity map rather than an ECS column.

## Inputs and Outputs
- **In**: an `AnimationSet` (families with `FrameSpec` timing/flags/boxes,
  transitions, `Interrupt` policy, action→family map); per-entity action
  requests (`request`/`restart`) and `advance(dt_ms)`; optional per-family target
  duration for time-fitting.
- **Out**: the current `frame` index (via `AnimationInstance::current_frame`),
  `finished` state, and the `direction_from_yaw*` quantizer. The engine combines
  frame + direction into the boundary cell.

## Key Logic
- **Time-fitting** (`schedule_frames`): no target → optimal timings. Target
  shorter than natural → shrink flexible frames toward `min_ms` proportional to
  each frame's room, then drop `skippable` frames in order; if still too long,
  accept an overshoot. Target longer → stretch toward `max_ms` proportional to
  room; if capped, accept an undershoot. "Stretchable"/"shrinkable" are implied
  by `max_ms`/`min_ms` vs `optimal_ms`; only skipping needs a flag.
- **Interruptibility**: per-family `Interrupt` — `Always` (interrupt anytime),
  `Block` (ignore until end), `Queue` (defer the request to the family's end) —
  plus a per-frame `cancelable` flag that opens an interrupt window even under
  Block/Queue. A queued request wins over the family's own `next` at end.
- **Transitions**: looping families wrap; one-shots flow to `next`, or hold the
  last frame (`hold_last`, e.g. death), or report `finished` and hold so the
  engine can choose what plays next. Re-requesting the playing family is a no-op
  (no restart) unless it has finished; `restart` forces frame 0 for an explicit
  retrigger (bumped action sequence).
- **Direction**: `direction_from_yaw` quantizes to 8 rows (0 = South, clockwise;
  row index runs opposite yaw); `direction_from_yaw_relative` is the billboard
  variant.
- **Frame events** (ADR 0017): a `FrameSpec.event: Option<u16>` marker. `advance`
  returns the event id of a frame *entered* that call — once on entry (tracked
  via `last_frame`), again each loop the frame recurs, never for a skipped/cut
  frame. Frame-synced, not time-synced: the effect rides frame entry regardless
  of how time-fitting stretched the schedule. The crate doesn't interpret ids;
  the engine maps them to gameplay actions.

## Invariants
- Family 0 is idle by convention and the terminal fallback of
  `family_for_action`, so a resolve never fails.
- `schedule_frames` never yields an empty timeline (falls back to frame 0 held
  at 0 ms).
- A dropped (skipped) frame produces no slot; kept frames are contiguous.

## Dependencies
None (no internal crates, no external crates). Assembled by `engine`, which owns
the per-entity instances, the loaded `AnimationSet`, and the per-tick drive that
writes cells to the ECS `anim` column for patch emission (see the engine spec's
animation section).

## Verification
`cargo test -p animation` — direction quantization across the ring incl. wrap and
the camera-relative variant; `schedule_frames` optimal / shrink / drop-skippable
/ stretch / stretch-capped; playback loop-wrap, one-shot hold+finish;
interruptibility Always/Block/Queue and the per-frame cancel window; same-family
no-restart; action resolution variant → wildcard → idle; frame events fire once
on entry and again each loop, and on a one-shot strike frame regardless of dt.
The engine adds the end-to-end pin: no bullet on the click, exactly one when the
attack's FIRE frame is entered.
