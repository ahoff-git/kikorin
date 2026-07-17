# ADR 0012: Frontier-only discovery with a detour-ratio filter; flying reactive avoidance

## Status
Accepted

## Context
Two playtest reports: 3D monsters never jumped over low walls, and flying monsters pressed against walls they could trivially fly over.

The wall-vault machinery (ADR 0011) was *correct* — every gate passed in isolation — but the sweep never finished on a real map: ~8k nodes → ~500k candidate pairs × ~5 raycasts each, correctly throttled by the adaptive slice to tens of seconds of gameplay. Two structural cuts fixed it. First, only **frontier nodes** (non-phase degree < 8) can anchor a new connection — open floor can't. Second, the boring-pair filter was rebuilt ray-free: one small window Dijkstra per frontier node gives graph distances through existing edges, and a near-flat pair is boring iff the graph already serves it within **2× the straight-line distance** (a detour *ratio*, not reachability — a pen wall you can walk around in 3.2× still deserves its vault; a boundary strip at 1.0× never pays for rays). This replaced `walkable_chord` entirely. Castle sweep: 1,259 promotions in 3 unthrottled ticks; ~1s of release gameplay throttled. Debug-build tests force the slice wide open (`tick_fast`) — they assert functionality, not debug pacing.

Flying monsters got the design doc's "Tier 0.5 reactive steering": one lookahead ray along the flight line (origin offset past the flyer's own collider — a solid raycast from body center hits itself at t=0), and when static terrain blocks, velocity redirects to mostly-up with slight forward drive. The climb naturally continues until the direct line clears — an emergent arc over walls with no pathfinding.

## Consequences
- Wall vaults exist within ~a second of map load; sweep cost no longer scales with map area, only with terrain-feature boundary length.
- The detour-ratio threshold (2×) is the knob deciding which shortcuts are "worth a jump" — larger maps with long walls may want it tuned.
- Flyer avoidance is purely reactive: a concave pocket (roofed courtyard) could still trap one; no aerial pathfinding exists (acceptable until a map has such geometry).
