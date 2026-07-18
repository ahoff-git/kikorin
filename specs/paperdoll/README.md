## packages/paperdoll — 8-Way Paper-Doll Sprite Animation

> **Status: v1 shipped, wired into the top-down sample game.** The pipeline,
> resolvers, bake cache, and the flat-sprite renderer are implemented; the
> top-down game renders its player and monsters through them. Deferred pieces
> are collected under [Implementation Status](#implementation-status-v1) — read
> that section for what is *not* yet real, so the rest of this spec (which
> describes the intended full contract) isn't mistaken for all-shipped. See
> ADR 0014.
>
> **Rust-driven now (ADR 0015, Phase 2):** the animation *simulation* lives in
> `crates/animation` and runs in the engine ([specs/animation](../animation/README.md)).
> This package now has two modes: pass `animFamilies` (index = engine `anim_id`)
> and the sprite displays the cell fed via `setCell(animId, frame, dir)` from the
> SemanticPatch anim fields — the top-down game uses this. Without `animFamilies`
> it keeps the standalone TS-derived behavior (the resolver/clock sections below).
> Either way the package owns only the *art* (manifest, bake cache, `THREE.Sprite`
> renderer, `texture.offset` cell selection).

### Purpose
Resolves what an animated character looks like *right now* — facing direction,
animation family, frame, and the ordered equipment layers to draw — and feeds
render backends one resolved contract. Games consume it to build and update
entity sprites; `system-rendering` stays a generic `Object3D` registry and is
not touched.

### Pipeline
Four stages, one data contract flowing through them:

1. **Pose resolver** — `(action state, yaw, camera azimuth?, clock)` →
   `ResolvedPose { direction: 0–7, family, frame }`.
2. **Equipment resolver** — loadout `{ slot → itemId }` → visual layers
   (layer slot + sheet reference per family), via the manifest.
3. **Layering resolver** — `(layers, direction)` → ordered `DrawPass[]`,
   via the layer-order matrix.
4. **Renderer adapters** — consume the draw stack: flat-sprite mode
   (2D ortho / top-down) or billboard mode (3D perspective), both drawing a
   single quad textured from the baked-layer cache.

Backends never see loadouts or manifests — only resolved poses and draw
stacks. That is what makes the three render modes share one system.

### Animation-State Contract

**How v1 drives state (shipped).** A sprite gets its state two ways, both
TS-side:
- *Facing* — the sprite reads the yaw the render channel already writes onto its
  `Object3D` (`setObjectTransformByEid`) and quantizes it. Nothing new crosses
  the boundary; every entity (player, monster, remote mirror) exposes yaw
  identically.
- *Locomotion* — `update()` auto-derives idle vs. walk from how far the sprite's
  Group moved since the previous frame. `setAction({kind, variant?, seq?})`
  overrides this with an asserted action (and `setAction(null)` resumes
  derivation); the top-down game leaves everything on auto-derive.

**Planned Rust contract (not yet implemented).** The intended source of truth
for discrete actions (attack pattern, hurt, death) is Rust, delivered by adding
three numeric fields to `SemanticPatch` — `action` (0 idle / 1 walk / 2 attack /
3 hurt / 4 death), `action_variant` (attack-pattern index), `action_seq`
(per-entity start counter; a change restarts a one-shot). When those land, the
game feeds them straight into `setAction` — the resolver interface is already
shaped for it, which is why v1 needed no Rust change. Notes that will apply
then: Rust owns all transitions (TS stops deriving locomotion too); airborne
stays out of the action enum (the pose side reads the existing `grounded`
field); and because semantic patches merge latest-wins within a ~16 ms flush,
`action_seq` is what makes a same-window retrigger visible. This contract is
defined here and will be referenced (not duplicated) by the adapter/patch specs
once the fields exist.

### Data Model
- `Direction` — 0–7, fixed order **clockwise from South**:
  `0=S, 1=SW, 2=W, 3=NW, 4=N, 5=NE, 6=E, 7=SE`. South-first because sheets
  are authored facing the camera. The yaw→direction quantizer (and the
  camera-relative variant for billboards) is the single place this mapping
  lives.
- `AnimationFamily` — a manifest-defined named animation. Dot-namespaced
  lowercase: `idle`, `walk`, `attack.slash`, `attack.thrust`, `hurt`,
  `death`. Arbitrary attack patterns are just more `attack.*` names — no
  schema change, only a manifest entry plus an `actionMap` row.
- `Loadout` — `{ slot → itemId }`, plain game data (TS side, per the Rust/TS
  separation). Layer slots use a fixed vocabulary, baseline back-to-front:
  `shadow, body, legs, torso, head, hair, helm, off_hand, main_hand`
  (extensible — the matrix defines actual order).
- `DrawPass` — `{ sheet, direction row, frame column, z }`; a `DrawStack` is
  the sorted pass list for one entity-frame.

### Sprite Source — an engine-defined location, consumer-supplied assets
The package ships **no sprite assets**, the same way the engine ships no maps
(`load_map(blocks)`) and no tuning — it defines *where* and *in what shape*
assets are expected, and the importing project provides them. This is the
whole point of the feature for kikorin: a place to put this stuff and a
contract for what goes there, not a bundled art set.

- A consumer registers one or more sprite sets via
  `registerSpriteSet(id, { baseUrl, manifest })`, where `baseUrl` is a root
  the consumer controls (a `public/` path, a CDN, a signed URL — the package
  only fetches relative to it) and `manifest` is the parsed manifest object
  (or a URL the package fetches). Sheet paths inside the manifest resolve
  against `baseUrl`.
- **How assets get to that location is the consumer's concern** — bundled in
  `public/`, streamed on demand, lazy-loaded per zone. The package fetches
  what a bake needs, when a bake needs it, relative to `baseUrl`; it neither
  prescribes nor prevents streaming.
- kikorin's own sample games are just one such consumer: they drop a set under
  `apps/web/public/sprites/<setId>/…` and register it. That path is a sample
  convention, not an engine requirement — no engine code hardcodes it.

### Sheet & File Conventions
- One sheet per `(item, family)`: rows = 8 directions in the fixed order,
  columns = frames. Every sheet in a sprite set uses the manifest's single
  `cell` size.
- Sheets may declare `rows: 4` (cardinals only); diagonals borrow the nearest
  cardinal. Default is 8.
- Within a set, sheet references are `baseUrl`-relative strings the manifest
  supplies per `(item, family)`; a human-friendly default layout is
  `<itemId>/<family>.png` beside the manifest, but the manifest is the source
  of truth — the package resolves whatever paths it names, wherever `baseUrl`
  points.

### Manifest Schema
One JSON per sprite set:

```jsonc
{
  "cell": [64, 64],          // px per frame, uniform across the set
  "anchor": [0.5, 1.0],      // sprite origin: bottom-center = feet
  "families": {
    "walk":          { "frames": 8, "fps": 12, "loop": true },
    "attack.slash":  { "frames": 6, "fps": 15, "loop": false, "next": "idle" },
    "death":         { "frames": 6, "fps": 10, "loop": false, "holdLast": true }
  },
  "actionMap": {             // "kind" or "kind.variant" → family name
    "0": "idle", "1": "walk",
    "2.0": "attack.slash", "2.1": "attack.thrust",
    "3": "hurt", "4": "death"
  },
  "fallbacks": { "attack.thrust": "attack.slash", "*": "idle" },
  "layerOrder": { /* matrix — see below */ },
  "items": {
    "leather-cap": { "slot": "helm", "sheets": { "idle": "…", "walk": "…" } }
  }
}
```

- Family fields: `frames`, `fps`, `loop`, `next` (family to auto-transition
  to when a one-shot ends; omitted = return to current locomotion),
  `holdLast` (freeze on final frame — death). Optional `events`
  (frame → marker name) is reserved for visual FX sync; no consumer in v1.
- An item missing a sheet for the active family walks the `fallbacks` chain;
  if the chain exhausts, that layer is omitted for the animation.

### Layer-Order Matrix
- `layerOrder` maps each layer slot → either a scalar z (direction-
  independent) or an 8-element array of z values, one per direction. This is
  what makes a held weapon draw in front of the body facing S/SE/SW and
  behind it facing N/NE/NW.
- The layering resolver sorts passes by z for the current direction; ties
  break by slot declaration order, so output is deterministic.
- A family may override the matrix wholesale
  (`families.<name>.layerOrder`) for animations that need different ordering
  (e.g. an overhead swing). Per-*frame* reordering is explicitly out of
  scope for v1.

### Baked Compositor & Cache
- Draw passes composite onto an offscreen canvas (`OffscreenCanvas` when
  available). A bake produces one **full sheet** per `(loadoutKey, family)` — a
  `frames × 8-direction` grid `CanvasTexture`, each direction row composited
  back-to-front for *its own* direction. Selecting a cell is pure UV math
  (`texture.offset`/`repeat`) at render time: frame is `offset.x`, direction is
  `offset.y`. So the canvas work happens once per look, and both "which frame"
  and "which way it faces" are free per-frame shifts — the Three.js-native
  sprite-sheet technique. A 4-row source sheet is expanded to 8 baked rows at
  bake time (diagonals duplicate their cardinal), so the runtime is always
  8-row.
- The baked `CanvasTexture` declares `SRGBColorSpace` (required for correct
  color under Three.js r152+ color management) with `NearestFilter` and no
  mipmaps for crisp pixel art.
- `loadoutKey` = stable hash of the sorted `(slot, itemId)` pairs. Bakes are
  lazy (first use) and shared — every entity with the same loadout and family
  reuses one cache entry regardless of direction/frame (monsters from one
  template all share one sheet). Per sprite, `texture.clone()` gives an
  independent `offset` while **sharing the baked Source**, so there's one GPU
  upload per look no matter how many sprites or which cell each shows.
- Cache-bust on equipment change is automatic: a new loadout mints a new key
  and simply stops referencing the old entry; the cache is a bounded LRU. (Far
  fewer entries now that it keys on `(loadout, family)` not direction — eviction
  is a leak backstop, not a hot path.)

### Renderer Adapters
Every entity renders as one `THREE.Sprite`. A Sprite always points at the
camera — Three's built-in billboard — which *is* the "lie flat" behavior: under
the top-down straight-down camera the sprite lies flat on the ground facing up,
and under a perspective camera the same primitive stands upright facing the
viewer (Doom-style). One object covers every mode with no orientation code, and
it ignores the yaw the render channel writes onto the object each tick, so the
sprite rides the existing pipeline rather than fighting it. The game registers
the Sprite via `upsertObjectByEid` like any `Object3D`; the render channel
positions it (and writes a rotation the Sprite ignores for facing). The package
**reads** facing only to pick the direction row. The `mode` selects only that
row math + anchor — all three sample games are wired (via the shared
`paperDollDirector` in `apps/web`):

- **`mode: "flat"`** (top-down / ortho): row = quantized entity yaw; `.center`
  is `(0.5, 0.5)` so the sprite sits on the entity. All 8 rows exercised.
- **`mode: "billboard"`** (3d perspective): row = quantized (entity yaw −
  camera-to-entity azimuth) so orbiting an entity walks all 8 rows; `.center`
  uses the manifest `anchor` (feet). The game passes the active `camera` to
  `update` (Rust's `anim_dir` is world-facing and can't know the TS camera, so
  billboard recomputes direction here from the render yaw).
- **`mode: "sidescroll"`** (2d side view): a fixed side-profile row, mirrored
  left/right by the sprite's own horizontal movement (a side-scroller has no
  yaw — facing is a flip via `scale.x`). Family/frame still come from the
  engine; direction is not Rust-driven here (2D entities carry no yaw).

Mode only changes the direction-row math and the anchor — orientation is Three's
billboard either way. The package exposes a per-frame `update(nowMs, camera?)`
the game calls in its RAF loop before `renderFrame()` — it advances the
animation clock, resolves family/direction/frame, rebinds the baked sheet clone
on a look change, and sets `texture.offset` for the cell. Sizing: the game
passes `worldHeight`; width follows the cell aspect (`sprite.scale`).

### Boundaries
- Owns: the sprite-set registry (`baseUrl` + manifest), manifest
  parsing/validation, sheet fetching relative to `baseUrl`, the three
  resolvers, the bake cache, the `THREE.Sprite` handle + per-frame update,
  animation clocks.
- Does **not**: ship or bundle any sprite assets, prescribe how assets reach
  `baseUrl` (bundled vs. streamed is the consumer's call), subscribe to
  adapter channels (games wire patches in — same pattern as `meshFactories`,
  keeping the package standalone), track entity lifecycle (games
  create/destroy sprites from lifecycle patches), decide gameplay transitions
  (Rust-canonical, above), or reach into `system-rendering` internals (games
  register the Sprite via `upsertObjectByEid` like any `Object3D`).

### Invariants
- Numbers, not names, are the (future) boundary currency: family names live
  only in the manifest/TS; only numeric kind/variant/seq would cross from Rust.
- When an explicit action carries `action_seq`, a change to it is the only
  trigger that restarts a one-shot; equal seq never restarts a playing one.
- A resolver always yields a drawable family: `familyForAction` and the
  fallback chain terminate at `idle`, so a sprite is never frameless (a set
  must therefore define `idle`; the sprite warns if it doesn't).
- One-shot families resolve an end state (`next` or `holdLast`).
- All sheets in a set share one `cell` size and the fixed direction-row order.

### Dependencies
- `three` (quads, `CanvasTexture`) and `@kikorin/util` (debug logging).
- Sprite sets (manifest + sheets) are consumer-supplied game data registered
  via `registerSpriteSet(id, {manifest, baseUrl?, sources?})`, not shipped by
  the package (per the Rust owns simulation / game owns data split — the sprite
  analog of `load_map(blocks)`). The top-down sample supplies a *procedural*
  set (canvas sheets via `sources`, no `baseUrl`); a real game would drop sheets
  under e.g. `apps/web/public/sprites/` and point `baseUrl` at them.
- The planned Rust action fields would touch `ecs`, `engine`, `patch`, and the
  `adapter` mirror types; those specs get updated when the fields land.
- Billboard mode (when wired) reads the active camera from the game each frame.

### Open Questions (implementation-time)
- Remote-peer loadout sync is a **consumer** concern, not the engine's: the
  package defines the location and the loadout→visual contract; getting a
  remote peer's loadout across the wire is game logic the importing project
  wires in (e.g. ride the netcode room channel like chat, ADR 0004, or encode
  a compact loadout id in a semantic field). The engine neither requires nor
  provides that transport. (This is why v1 renders remote mirrors as boxes, not
  sprites.)
- When the Rust action fields land, verify they replicate to remote mirrors
  under the existing NET-flag rules (expected, unverified).

### Implementation Status (v1)
**Shipped**: the four-stage pipeline; direction quantizer (both flat and
camera-relative math); manifest types + registry + family/sheet resolution with
fallback; the three resolvers; the full-sheet compositor (sRGB `CanvasTexture`,
`(loadout, family)`-keyed bounded LRU); the `PaperDollSprite` handle built on
`THREE.Sprite` (points at the camera in every mode — flat under top-down,
upright under perspective; per-frame `update`, `texture.offset` cell selection
with per-sprite source-sharing clones, loadout swap, `setAction`); in-memory
*or* `baseUrl` sheet sources; and the **Rust-driven `setCell` mode**
(`animFamilies`) that displays the engine-emitted cell. Wired into the top-down
game: player and monsters render as layered 8-way sprites (body + hat + sword;
per-direction weapon ordering), **driven by the Rust animation state machine** —
idle/walk from velocity, an attack one-shot on fire. 31 co-located unit tests
pass; verified in a real browser (walk cycle, the attack swing arc advancing
under Block, direction rows, per-direction sword layering, correct colors).

**All three sample games now render sprites** through a shared
`apps/web/src/app/paperDollDirector.ts`: top-down (flat), 3D (billboard), 2D
side-scroller (sidescroll). Bullets stay spheres; remote-peer mirrors stay boxes
(loadout sync deferred).

**Not yet implemented / deferred**: authoritative hit/hurtbox combat (Phase 3 —
geometry carried, unconsumed); the 2D player's attack animation (its `fire()`
spawns a bullet directly rather than via `player_fire`, so no attack action is
requested — idle/walk only there); monster types render identically (all use the
red loadout — the per-template color distinction the boxes had is lost);
per-item sheet fallback; manifest schema validation beyond crash-guards;
networked remote-peer loadouts. Graphics are procedural placeholders
(`paperDollAssets.ts`) that double as the authoring example — a real PNG sheet
set + JSON manifest is a follow-up.

### Cookbook — authoring without hating life
The whole family set (art + behavior) is single-sourced from one `FAMILIES_SPEC`
array in `apps/web/src/app/paperDollAssets.ts`; everything below flows from
editing that (and, for new art, the item drawers). This is the recommended
pattern — see ADR 0019 for why (the index-alignment footgun).

- **Add an animation** (e.g. `hurt`): add one `FAMILIES_SPEC` entry (name, loop,
  frames, optional `interrupt`/`movement`), add a `case "hurt"` to the item
  drawers, and map an engine action kind to it. `FAMILY_ORDER`, the manifest
  families, frame counts, and the `load_animations` payload all derive from it.
- **Swap armor/weapons**: change the entity's loadout — `createPaperDollSprite({
  loadout })` or `sprite.setLoadout(...)`. A new loadout mints a new bake key;
  the old strips age out of the LRU. Equipment is just layer-slot → item id.
- **Fire on a specific frame** (ADR 0017): put `event: <id>` on that frame in
  `FAMILIES_SPEC`; the engine maps the id to an action (today id 1 = spawn the
  player's bullet in `on_anim_event`). The effect stays locked to the frame no
  matter how the animation is timed.
- **Constrain movement during an animation** (ADR 0018): add `movement: {
  forward: false, jump: false }` (etc.) to the family — omit a field to allow it.
  The engine's player controller gates input while that family plays.
- **Stretch/cut to a duration**: give frames `min_ms`/`max_ms` and mark filler
  frames `skippable`; the engine can fit the family to a target time.
- **Add an attack variant** (`attack.thrust` vs `attack.slash`): a second family
  + an `actionMap` entry keyed by `kind.variant`; the engine picks it via
  `action_variant` (once combat drives variants).
- **Death** (ADR 0020): add a `hold_last` death family mapped to `ANIM_KIND_DEATH`.
  Lethal damage plays it and despawns the entity when it finishes — it also stops
  eating bullets / steering the instant it dies. No death family = instant destroy.
- **Hurt / flinch**: add a short blocking family mapped to `ANIM_KIND_HURT`;
  non-lethal damage requests it.
- **Combo / rapid re-swing**: set `retriggerable: true` on the family so clicking
  again restarts it (ADR 0018).

### Limitations, gotchas & open questions
Read before shipping on this — the things a user *will* trip on:

- **Family alignment is by index, unchecked across the boundary** (ADR 0019 —
  which now explains it in full). Rust `anim_id` ↔ TS family name ↔ frame counts
  must agree by order; the package can't verify it. Single-source them (as the
  sample does). A frame-count mismatch clamps to the last frame (no garbage), but
  a *name/order* mismatch shows the wrong animation silently.
- **Death is animated for combat-killed entities** (ADR 0020) — monsters play a
  death animation then despawn. The *player* would use the same path, but nothing
  damages the player in the sample games yet.
- **Monsters play locomotion + death + hurt, but not attack** — nothing makes a
  monster attack (they only chase); the def can carry a monster attack but no
  engine hook requests it. Monster hurt rarely shows because monsters usually die
  in one hit (tuning, not a bug).
- **2D player has no attack animation** — its `fire()` calls `spawn_bullet`
  directly, bypassing the `player_fire` → attack path.
- **Monsters all look the same** (red loadout); per-template visual variety isn't
  mapped to loadouts yet.
- **Remote peers render as boxes** — networked loadout sync is deferred.
- **Bake cache never evicts; it doubles when full** (ADR 0020) — chosen over
  evicting a texture a live sprite still shares. Can grow unbounded in a
  pathological equipment matrix; accepted, ref-counting is a future option.
- **`sidescroll` uses a fixed side-profile row (East)** and derives its flip from
  horizontal movement; the row isn't configurable yet.
- **Sub-flush frame changes coalesce to the latest** (the worker merges semantic
  patches latest-wins at ~16 ms ≈ render rate). This is correct — the scene can't
  render >60 fps — and the *current* cell always reaches TS (it rides every
  semantic patch, see the patch spec; a bug where no-change ticks clobbered it
  and froze the sprite is fixed). Frame *events* are dispatched in Rust and are
  never dropped, so gameplay stays correct regardless.
- **No TS-side (presentational) frame callbacks yet** — only engine gameplay
  events. Surfacing events across the boundary as a queued slice (like `hits`) is
  the natural follow-up for sound/FX hooks.

### Verification
- Unit (`pnpm --filter @kikorin/paperdoll test`, 31 tests) — the pure logic:
  yaw→direction quantization across the full ring incl. wrap and the
  camera-relative variant; `frameAt` loop-wrap and one-shot clamp/`done`;
  `familyForAction` + fallback-chain resolution terminating at idle; manifest
  validation guards; `loadoutKey` order-independence; `resolveEquipment`
  dropping unknown items; `resolveLayering` z-ordering per direction with
  slot-order tie-break and null-sheet passthrough; `sheetRowForDirection` for
  8- and 4-row sheets.
- Browser (manual, same stance as `system-rendering`'s GL paths — no GL in the
  node suite): the sprite handle, the bake compositor, orientation, and UV
  frame-stepping are confirmed by running the top-down game. v1 was checked
  this way — player facing east/north/west, walk vs. idle, and the sword layer
  flipping in front (south/east) vs. behind (north).
