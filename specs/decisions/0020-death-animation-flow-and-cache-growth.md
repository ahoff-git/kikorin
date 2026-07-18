# ADR 0020: Death animation flow (the dying state), hurt, and a non-evicting bake cache

## Status
Accepted — implemented in `crates/engine` + `crates/animation` + the paperdoll
bake cache; monsters play a death animation, then despawn.

## Context
Death used to be an instant `destroy_entity` (ADR 0015's spec even called this
out — a `hold_last` death family could never play, because the entity was gone by
the time it would). Combat should instead trigger a death *animation*, and use it
to time the despawn. Two related items ride along: a quick hurt reaction on
non-lethal damage, and removing the bake cache's eviction hazard.

## Decision

### The "dying" state drives despawn
On lethal damage the engine no longer destroys immediately. It enters a `dying`
state for that entity:
1. If there's a real (non-looping) death family (`family_for_action(DEATH)`
   resolves to a non-looping family), add the id to `Engine.dying`, zero its
   velocity, and request the DEATH action. Otherwise (no death animation)
   destroy immediately, as before — graceful fallback.
2. **A dying entity stops acting at once**: it's excluded from monster AI
   (no chasing/steering), from separation (no push), and from the bullet-target
   snapshot (it stops "eating bullets"). It also stops deriving locomotion, so
   the death animation holds. This is exactly the "stop being considered for
   collision / spreading / steering the moment it dies" the design called for.
3. When the death animation finishes (`AnimationInstance::finished()`, which a
   `hold_last` one-shot reports at its end), `finish_death` despawns it and —
   for monsters — respawns per `MonsterConfig` (respawn was previously immediate;
   now it waits for the animation).

The physics body stays until despawn, so the corpse rests on the floor rather
than freezing mid-air.

### Hurt is the non-lethal sibling
Damage that doesn't kill requests a HURT action — a short, blocking flinch that
plays over locomotion, then returns to it. It's a no-op if the set has no hurt
family. (In the sample, monsters mostly die in one hit, so hurt shows rarely —
it's wired and correct, just tuning-dependent.)

### The bake cache grows instead of evicting
Per-sprite textures are `clone()`s that share a cached texture's `Source`;
evicting (disposing) a cached texture out from under a live sprite would break
it. So the cache's soft cap **doubles when hit** rather than evicting. At
realistic look counts it never trips; if a huge equipment matrix ever pushes past
it, memory grows a little — accepted (per the "no big deal, just double it"
call). Ref-counted eviction remains a future option if it ever matters.

## Consequences
- Death is now animated and self-timed; respawn waits for the death animation.
  A `hold_last` death family finally works as intended.
- **Death is wired for combat-killed entities (monsters here).** A hurt/death
  for the *player* would use the same path, but nothing damages the player in the
  sample games yet.
- Only entities with a non-looping death family enter the dying state; everything
  else still destroys instantly — no behavior change for animation-free games.
- The cache can grow unbounded in pathological cases; chosen over the correctness
  hazard of evicting live shared textures.

## Rejected alternatives
- **Keep instant destroy + a separate corpse entity**: more moving parts than
  reusing the entity's own animation instance; the dying-set approach keeps the
  entity and just changes what systems consider it.
- **Ref-counted cache eviction now**: more machinery than warranted; doubling is
  enough until look counts are large.
