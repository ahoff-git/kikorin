# ADR 0014: Paper-doll sprites via a renderer-agnostic resolved-pose contract

## Status
Accepted, partially superseded. v1 shipped (`packages/paperdoll`) wired into the
top-down game: resolved-pose contract, `THREE.Sprite` renderer, full-sheet sRGB
bake, `texture.offset` selection — all still current. The **resolver-ownership**
half (pose/timing/frame resolution and action state in TypeScript) is superseded
by [ADR 0015](./0015-animation-simulation-in-rust.md), which moves animation
simulation into Rust (`crates/animation`); the TS resolvers are replaced by
Rust-driven cells in that ADR's Phase 2. See [specs/paperdoll](../paperdoll/README.md).

## Context
The one remaining TODO item: "a way to manage 8-way paper-doll (layered sprite)
animations" supporting armor, weapons, multiple attack patterns, and **all**
render modes (3D perspective, 2D ortho side-scroller, top-down ortho).

Two forces pull against each other. The render modes differ in how a sprite
must orient (a fixed-camera flat quad vs. a camera-facing billboard), and the
project's Rust/TS split ([architecture](../architecture/README.md)) says Rust
owns canonical simulation while the game owns data like maps and tuning —
sprites and loadouts are game data. So the animation system must live TS-side,
must not fork per render mode, and must not re-derive gameplay state TS already
gets from Rust.

## Decision
**A four-stage pipeline behind one resolved-pose contract**, in a new standalone
`packages/paperdoll`:

1. Pose resolver: action state + yaw (+ camera azimuth for billboards) →
   `{direction 0–7, family, frame}`.
2. Equipment resolver: loadout → visual layers, via the manifest.
3. Layering resolver: layers + direction → ordered draw passes, via a
   layer-order matrix (z per direction, so a weapon sits in front facing south
   and behind facing north).
4. Renderer adapters: flat-sprite (fixed-camera ortho) and billboard
   (Doom-style, camera-facing) both consume the same draw stack.

Backends see only resolved poses and draw stacks — never loadouts or the
manifest — which is what lets the three render modes share one system rather
than forking. The package stays standalone like `meshFactories`: games wire
patches in and own sprite lifecycle; it never subscribes to adapter channels or
reaches into `system-rendering`.

**Animation state is Rust-canonical**, extending the pattern combat already
uses. `SemanticPatch` gains numeric `action` (idle/walk/attack/hurt/death),
`action_variant` (attack-pattern index), and `action_seq` (per-entity start
counter). Rust owns every transition; TS never infers actions from position
deltas. Airborne is not an action — the resolver reads the existing `grounded`
field. Only numbers cross the WASM boundary; family names are a TS/manifest
concept. A seq change is the sole trigger that restarts a one-shot animation.

**Layers are composited once and cached, keyed by loadout.** Draw passes bake to
an offscreen canvas producing one full `frames × 8-direction` sheet per
`(loadout, family)` as a `CanvasTexture`; frame and direction are both chosen at
render time via `texture.offset` (the Three.js-native sprite-sheet technique),
never per-frame canvas work. `loadoutKey` is a hash of the sorted loadout, so
every entity sharing a loadout/family reuses one immutable cache entry (all
monsters of a template reuse it); per-sprite `texture.clone()` shares that
baked Source so there's one GPU upload per look. Equipment change mints a new
key and stops referencing the old entry; a bounded LRU ages orphans out. This is
why the compositor is "layered offscreen, then cached, cache-bust on gear
change."

**The renderer is `THREE.Sprite` for every mode.** A Sprite always points at the
camera (Three's built-in billboard), which is what "lie flat" means here: under
the top-down straight-down camera it lies flat on the ground facing up, and under
a perspective camera the same primitive stands upright facing the viewer
(Doom-style). Facing is conveyed by the 8-way *art row*, chosen from the entity's
"front" yaw — the Sprite never rotates to the heading. Mode selects only the
row math (yaw vs. camera-relative azimuth) and the anchor. Frames/directions are
picked with `texture.offset` (the Three.js-native sheet technique). A
fixed-orientation flat `Mesh` was briefly tried to make "lie flat" literal, but
that's redundant: the built-in billboard already gives the point-at-camera
behavior that "lie flat" asked for. The resolved-pose contract is unchanged;
only the backend that consumes it.

**Arbitrary attack patterns need no schema change**: they are additional
`attack.*` family names in the manifest plus an `actionMap` row keyed by
`kind.variant`.

**The engine defines the sprite location; it ships no sprites.** kikorin is
meant to be imported for its engine — an importing project wires in its own
game logic and gets pathfinding/rendering/animation for free. So paper-doll
follows the same "engine owns the interface, game owns the data" split as
`load_map(blocks)`: the package exposes `registerSpriteSet(id, {baseUrl,
manifest})` and fetches sheets relative to the consumer-controlled `baseUrl`.
Whether assets are bundled or streamed from that location is entirely the
consumer's call. kikorin's own sample games are just one consumer, dropping a
set under `apps/web/public/sprites/`; no engine code hardcodes that path.

## Consequences
- **New cross-boundary contract**: the three semantic action fields touch
  `ecs`, `engine`, `patch`, and the `adapter` mirror types. Those specs update
  when the fields land; [specs/paperdoll](../paperdoll/README.md) is the single
  definition of the field meanings until then.
- **Rust must emit action transitions it currently only implies.** Idle/walk,
  hurt, and death map cleanly to state Rust already has; per-attack-pattern
  `action_variant` requires combat to know which pattern fired, which may not
  exist yet — a real (small) engine change, not free.
- **Remote-peer loadout transport is a consumer responsibility, not the
  engine's.** The package defines the location and the loadout→visual
  contract; delivering a remote peer's loadout across the wire is game logic
  the importing project wires in (netcode room channel like chat, ADR 0004, or
  a compact loadout id in a semantic field). Local play works without it. This
  is a deliberate boundary, not an omission — it's the same reason the engine
  ships no maps.
- **Billboard mode couples the package to the game's active camera** each frame
  (needed for camera-relative direction). Flat modes don't; the per-frame
  `update(now, camera?)` makes the camera optional.
- **Per-frame layer reordering is out of scope for v1** — ordering varies by
  direction and (optionally) by family, not by frame. An animation needing a
  hand to cross in front of the torso mid-swing can't be expressed yet.
- A future non-baked path (stacked planes or a shader) can be added as a fourth
  renderer adapter behind the same resolved-pose contract without disturbing
  the resolvers — the contract, not the compositing strategy, is the stable
  part.

## Rejected alternatives
- **TS-derived animation state** (infer walk/attack from motion and hit
  events): no source of truth for which attack pattern played, and fights the
  Rust-canonical simulation rule. Rejected.
- **Per-render-mode sprite systems**: duplicates logic across modes, the exact
  thing the resolved-pose contract exists to prevent, and violates the
  no-duplicated-logic constraint.
- **Stacked transparent planes / shader texture-array layering** as the v1
  compositing strategy: more draw calls or more cleverness for no benefit at
  these entity counts; the baked cache is simpler to debug. Kept as a possible
  future adapter, not the default.
- **LPC / Aseprite-native asset formats**: LPC is natively 4-direction (8-way
  needs a nonstandard extension) and Aseprite-native couples the pipeline to
  one tool. A custom manifest with a fixed grid convention stays tool-agnostic
  and hand-authorable.
