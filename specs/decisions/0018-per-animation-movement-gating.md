# ADR 0018: Per-animation movement gating (move mask)

## Status
Accepted — implemented in `crates/animation` + `crates/engine`; the sample
attack roots the player (but lets them turn to aim).

## Context
Different animations should permit different movement while they play: an attack
might root you, a reload might let you walk but not sprint, a heavy swing might
forbid jumping, a crouch-fire might allow turning only. Without this the player
could walk freely during a committed attack swing — the character "moonwalks,"
and the animation reads as decorative rather than a real commitment.

## Decision
**Each family carries a `MoveMask`** — `forward`, `strafe`, `turn`, `jump`,
`crouch` booleans, all defaulting to `true`. The engine's player controller
looks up the player's current family's mask each tick and zeroes any disallowed
input before computing movement/facing/jump. So a family constrains movement
purely as data, not code.

- **Default is fully permissive**, and locomotion families keep it — so gating
  only ever *tightens* behavior once a restrictive family (attack, etc.) plays.
  No animation set, or no instance yet, → `MoveMask::ALL` → unchanged behavior.
- **Authored as forbiddances**: the boundary DTO defaults every field to `true`,
  so a family lists only what it forbids: `{ forward: false, strafe: false,
  jump: false }` = "plant, but you may still turn to aim."
- **Jump edge-detects on the gated value**, so a jump held through a no-jump
  animation fires the instant the animation frees it (buffered), rather than
  being swallowed.
- **`crouch` is reserved** — the sample controller has no crouch input yet; the
  flag exists so the data model is complete.

## Consequences
- Fixes the moonwalk: the sample attack (`interrupt: block` + `movement: {
  forward:false, strafe:false, jump:false }`) plants the player for the swing
  while still letting them turn to aim — and firing at the strike frame (ADR
  0017) then shoots where they aimed.
- **Player-only today.** Monsters are AI-driven, not input-driven, so nothing
  gates their movement by mask; an AI could consult `move_mask` later if we want
  monster attacks to root them.
- **One-tick lag**: the controller reads the family `drive_animation` set on the
  previous tick (steps 2 vs 6 of the tick). Negligible at a 4 ms step.
- Purely engine-side: the game only authors the mask in the animation def; no
  per-frame TS involvement.

## Rejected alternatives
- **Gating in TypeScript** (have the game suppress input during certain
  animations): forks movement rules across the boundary and can't stay
  authoritative — the controller lives in Rust. Rejected.
- **A single "rooted" boolean** instead of a mask: can't express "turn-only" or
  "walk-but-no-jump," which are exactly the cases asked for.
