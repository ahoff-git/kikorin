# ADR 0021: Combat — aggro/leash, monster melee, and player death/respawn

## Status
Accepted — implemented in `crates/engine`; the 3D sample (`apps/web`) enables it
and shows a player health bar. Off by default: every pre-combat game and unit
test is unaffected until a game opts in via `set_ai_config` / `set_player_config`.

## Context
The engine had one-directional combat: the player shoots bullets that damage
monsters (monster health, death animation, respawn — ADR 0020). Nothing damaged
the player, monsters chased any player from anywhere on the map, and there was no
melee. The requested trio: monsters should have **aggro radiuses and leashes**,
players should have **health**, and monsters should **deal damage**.

The damage model was chosen deliberately (over simple contact-tick damage):
**contact + attack animation** — a monster in reach stops and plays its attack,
and damage lands on the attack's *strike frame*, reusing the frame-synced event
machinery (ADR 0017). This keeps damage locked to the visible swing regardless of
animation speed, exactly like the player's bullet spawn.

## Decision

### Opt-in, numbers in config
New tuning lives in the existing game-supplied config structs (the engine owns
the mechanics, the game the numbers — same split as `bullet_damage`):

- `AiConfig`: `aggro_radius`, `leash_radius`, `melee_range`, `melee_damage`.
- `PlayerConfig`: `max_health`.

All default to the *combat-off* values (`aggro_radius`/`leash_radius`/
`melee_damage` = 0), so an untouched engine behaves exactly as before: unbounded
chase, no leash, nothing damages the player. A game turns combat on by setting
them (`aggro_radius > 0` enables aggro-gating; `melee_damage > 0` enables melee).

### Aggro / leash
Each monster records its spawn XZ as a **home** (leash anchor) and a sticky
`aggroed` flag. `resolve_goal` wraps the existing pure `goal_for` (unchanged, so
its unit tests still hold) and layers the state machine on top **only** when
`goal_for` reports a player chase and `aggro_radius > 0`:

- not aggroed → aggro if the player is within `aggro_radius` **and** the monster
  is within `leash_radius` of home;
- aggroed → keep chasing until the monster strays past `leash_radius` from home,
  then de-aggro and walk home (`chasing = false`, so the dispatcher routes to the
  home point rather than the shared player flow field).

Re-aggro is gated on being back within `leash_radius` of home. Without that gate,
a player kiting a monster to the leash edge would make it de-aggro (far from home)
then immediately re-aggro (player still close) every tick — visible flicker. The
gate makes a leashed monster commit to walking home before it can re-engage.

Grounded and flying monsters share `resolve_goal`; the flyer additionally tracks
the player's altitude, but only while actually chasing.

### Monster melee (contact + attack anim)
In `tick_monster_ai`, before pathfinding, a monster with a player within
`melee_range` stops (zero velocity), faces the player, and requests its attack
action. While the attack is mid-swing it stays rooted (so a whiff is decided by
range at the strike, not by the monster wandering off). Rooting with a zero
velocity matches the flyer's own "reached goal" stop, so both mover types use one
path.

The **strike event is actor-dispatched**: event id 1 marks the attack's strike
frame, and `on_anim_event` routes it by *who* struck — the player's strike spawns
a bullet (ADR 0017), a monster's strike deals melee damage. This lets the player
and monsters share one attack family with no extra authoring; the damage only
lands if the player is still within `melee_range` at that frame. Only the local
registered player is a melee target — remote mirrors are their owner's authority
(the same rule bullet damage already follows).

### Player health, death, and respawn
Damage to the player mirrors the monster settlement in `tick_bullets`: non-lethal
plays a quick hurt flinch, lethal starts the ADR 0020 dying flow. The player is
**never destroyed** — `finish_death` branches on the player id and *respawns in
place* instead: it restores `PlayerConfig::max_health`, teleports to the position
captured at `register_player`, clears the dying state, and drops the animation
instance so it returns to idle. The entity id, controller registration, and mesh
all survive, so the camera and input keep working across a death. While dying, the
controller is frozen and firing is suppressed.

`register_player` does **not** overwrite the spawned entity's health — a game
that spawns the player with a health value keeps it; `max_health` is only the
respawn target. Games should spawn the player with `max_health` for a consistent
starting bar (the 3D sample does).

## Consequences
- **Melee cadence = attack length.** The Block attack plays fully before another
  can start, so damage rate is set by the attack animation, not a separate timer.
  A game tunes cadence by tuning the attack def.
- **A game with combat on but no attack family that marks a strike frame** gets
  monsters that root in reach but never deal damage (the swing has no strike). The
  strike frame is part of authoring the attack, same caveat as the player's FIRE
  frame in ADR 0017.
- **Reusing the strike event across actors** means a game can't give monsters a
  visually different attack without a distinct family; the action map already
  supports variants (`ANIM_KIND_ATTACK` + variant) if a game wants a dedicated
  monster-melee animation later.
- **Player respawn is in-place, not a spawn/despawn.** No lifecycle patch fires
  on player death, so the mesh is reused rather than recreated — the HUD sees the
  health drop to 0 and back to full via the SemanticPatch, which is what drives
  the health bar.
- **2D**: the 2D game's player is TS-driven (the engine controller is a no-op
  there), so the freeze-while-dying and respawn-teleport paths don't apply to it;
  combat is demonstrated in the 3D sample. Enabling melee against a 2D TS-driven
  player is possible but out of scope here.
- **Verified**: cargo tests cover aggro gating, leash + no-flicker re-aggro,
  melee landing in range / whiffing out of range, the strike-frame integration
  path, and lethal-damage → in-place respawn at full health; the 3D sample was
  exercised in-browser.
