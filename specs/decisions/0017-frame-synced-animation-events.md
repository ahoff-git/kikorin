# ADR 0017: Frame-synced animation events (callbacks)

## Status
Accepted — implemented in `crates/animation` + `crates/engine`; the top-down and
3D games spawn the player's bullet on the attack's strike frame.

## Context
Gameplay effects tied to an animation — spawning a projectile when a swing
connects, a melee hitbox going live on the strike — must fire on the *frame*,
not on the input that triggered the animation. Otherwise the effect drifts out
of sync whenever the animation is stretched or cut short by time-fitting (ADR
0015/0016). The request: "call this function after this frame" so e.g. the
bullet spawns in sync with the strike frame regardless of animation speed.

## Decision
**Frames carry an event marker; the state machine reports it on entry; the
engine dispatches the action.** A pure, three-part hook:

1. **`crates/animation`**: `FrameSpec.event: Option<u16>` — an opaque marker the
   crate doesn't interpret. `AnimationInstance::advance` returns the event id of
   a frame *entered* this call, once (tracked via `last_frame`): it fires when a
   frame first becomes the shown frame, not every tick it's held, and again each
   loop when the frame recurs. A dropped (skipped/cut) frame never fires. This
   is what makes it frame-synced, not time-synced — the schedule maps frames to
   whatever (fitted) time slots, and the event rides frame entry.

2. **`crates/engine`**: `drive_animation` collects each entity's event from
   `advance` and dispatches it to a gameplay action (`on_anim_event`). Today one
   mapping: `ANIM_EVENT_FIRE` on the *player* spawns the bullet
   (`fire_player_bullet`). The id→action table is engine gameplay code (the
   "function"); ids are numeric, like everything crossing the boundary.

3. **`player_fire` becomes a request, not a spawn**: with an animation set
   loaded it only requests the attack action, and the bullet spawns when the
   attack's FIRE frame is entered. Without an animation set it fires immediately
   (unchanged for games that never load animations — the 2D game fires via
   `spawn_bullet` directly and doesn't call `player_fire`).

The bullet uses the player's facing/aim *at the fire frame*, so aim tracks
through the wind-up.

## Consequences
- **Fire rate is gated by the attack's interrupt policy.** The demo attack is
  `Block`, so it plays fully and one shot fires per attack — deliberate (the
  shot lands with the swing). A faster or interruptible attack changes that
  purely by tuning the animation def.
- **A loaded animation set must mark a FIRE frame on the attack**, or the player
  won't shoot (the request plays an attack that fires nothing). This is part of
  authoring the attack; the fallback-to-immediate only applies when *no* set is
  loaded.
- **Verified**: a cargo test asserts no bullet on the click and exactly one when
  the FIRE frame is crossed; in-browser the bullet spawns ~185 ms after the
  click (the wind-up), not instantly.
- **TS-side callbacks now exist too.** Frame events are surfaced across the
  boundary as a queued `anim_events` bundle slice → `animEventsChannel` →
  `onAnimationEvent(id, cb)` (`apps/web/src/app/animationEvents.ts`), mirroring
  how `hits` works, so TS game logic can react to animation frames (sound, FX,
  custom hooks). The engine still dispatches gameplay events (the bullet) itself;
  this is the additive TS-facing half.
- Multi-frame skips within a single 4 ms tick would report only the last
  entered frame's event; not a concern at the current step size and frame
  lengths, noted for correctness.
