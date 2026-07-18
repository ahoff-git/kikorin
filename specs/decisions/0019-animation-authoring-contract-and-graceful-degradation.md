# ADR 0019: Animation authoring contract & graceful degradation

## Status
Accepted — validation + clamps implemented in `crates/animation` /
`crates/engine`; the sample derives its whole family set from one source.

## Context
Stress-testing the animation system surfaced two classes of problem a real user
would hit: **malformed definitions crashing the engine**, and **the family set
being declared in several places that can silently drift out of alignment.**
Both make the system miserable to use; this ADR records how we handle them.
(The broader "not-yet-handled" list lives in the specs' Limitations sections,
not here — ADRs record decisions, not open questions.)

## Decision

### Malformed defs degrade gracefully, never panic
A bad `load_animations` payload must not take down the whole WASM engine (a Rust
panic in wasm is unrecoverable). So:
- `AnimationSet::validate()` checks the set is drivable: ≥1 family, every family
  has ≥1 frame, every action maps to an existing family index.
- `build_animation_set` runs it and returns `None` on failure; `load_animations`
  logs a warning and **leaves animation inert** (existing set unchanged, or none)
  rather than installing a broken set.
- Defense in depth for anything that slips through: `family_for_action` clamps an
  out-of-range mapping to family 0, and `AnimationInstance::start` clamps a stale
  index (e.g. a `next` into a set that was later reloaded smaller).
- **Reloading animations clears live instances** (their family indices refer to
  the old set), so a hot-reload can't leave a dangling index.

Result: a typo in an animation def produces a console warning and un-animated
(but fully playable) entities — not a crash.

### Family alignment is by index convention, single-sourced by the consumer
The family set's **order is the contract**: family index = the engine's
`anim_id` = the TS manifest's family list = `FAMILY_ORDER` (the id→name bridge) =
the per-family frame counts on both sides. These must agree, and the paperdoll
package **cannot verify it** — the Rust defs and the TS art live on opposite
sides of the WASM boundary. Getting it wrong is the classic paper-doll footgun.

Mitigations we commit to:
- The sample game derives **all** of it — `FAMILY_ORDER`, the manifest families,
  frame counts, and the `load_animations` payload — from **one** `FAMILIES_SPEC`
  array (`apps/web/src/app/paperDollAssets.ts`), so they can't drift. This is the
  recommended pattern for any consumer.
- The sprite clamps an out-of-range frame index at bake/display time, so a
  frame-count mismatch degrades to "shows the last frame," not garbled UVs.

We deliberately did **not** try to enforce alignment inside the package (it
can't see the Rust set) — the contract is documented and the single-source
pattern makes it structural instead.

## Consequences
- The engine tolerates garbage input; consumers get a warning + graceful
  degradation, which is the "don't make me hate life" baseline.
- Adding a family is a one-line change in `FAMILIES_SPEC` (+ a draw case), and
  everything else follows — no four-places-in-sync ritual.
- The clamps are belt-and-suspenders; `validate` is the real gate.

## Rejected alternatives
- **Panic / assert on malformed input**: unrecoverable in wasm, terrible DX.
- **Cross-boundary alignment checks in the package**: impossible (the Rust set
  isn't visible to TS); replaced by the single-source pattern + frame clamp.
