# ADR 0007: Cross-peer bullet hits reuse existing replication, not a new wire message

## Status
Accepted

## Context
Monsters are `NET_LOCAL | NET_MONSTER | NET_REPLICATED | NET_LOW_URGENCY` — simulated by whichever peer spawned them, mirrored (display-only, no collider, no real `net_flags`) on every other peer. Bullets are `NET_BULLET | NET_REPLICATED | NET_PREDICTABLE` — simulated by whichever peer fired them, likewise mirrored elsewhere. `tick_bullets`' hit-detection scan built its monster snapshot from `self.world`'s real `net_flags` — exactly the field mirrors never carry (`mirror_flags`, a separate map, holds a mirror's public profile instead, specifically so engine systems ignore mirrors as non-simulatable). The result: a bullet only ever collided with monsters owned by the *same* engine that fired it. In any session with more than one peer, a monster not owned by the shooter was structurally invisible to that shooter's hit-detection — reported as "bullets hitting shared monsters do not register hits nor kill them."

Two shapes were considered:
1. **A new wire message**: the shooter detects a speculative hit against a monster mirror (using its own possibly-stale, extrapolated view of that monster's position) and sends a report to the monster's owner, who validates and applies it.
2. **Flip which side checks**: since bullets are already replicated to every peer, have the monster's *owner* check its own real (unmirrored, authoritative) monsters against every bullet it can see — including bullet mirrors from other peers — using data that already arrives via the existing replication cadence.

Shape 2 needed no new protocol, no round-trip, and no speculative-vs-authoritative reconciliation logic: the peer making the health-mutating decision is the same peer that already owns the health. It fits the codebase's one existing hard rule for mirrors — never mutated as if they were real state, only read — introduced here for the first time on the *reading* side (a hit-check reads a mirror's position; nothing writes through one).

## Decision
`tick_bullets` gained a second pass, run every tick alongside the existing local-bullet-vs-local-monster loop: it collects every entry in `mirror_flags` carrying `NET_BULLET`, reads each one's live (extrapolated) position from `self.world`, and checks it against the same local monster snapshot the first pass already built. A hit applies `PlayerConfig::bullet_damage` to the real monster (exactly the existing consequence-application code, unchanged — a monster hit twice in one tick by any combination of local and mirror bullets already collapses correctly via its "already destroyed this tick" guard) and destroys the *local mirror* of the bullet (via the existing, already mirror-aware `destroy_entity` — the same function silent-peer timeout and real `Despawned` messages already use to force-destroy a mirror out of band with its remote owner).

Both passes are skipped together only when there's truly nothing to check (no local bullets *and* no mirror bullets) — the common case for a session with no peers connected yet — so this costs nothing when unused.

## Consequences
- **A shared PvE monster pool now actually works**: any connected peer's bullets can damage and kill any monster, regardless of who spawned it, using only data the engine already receives.
- **The firing peer's own bullet visually vanishes on the monster-owner's screen but keeps flying on the firer's own screen** for the remainder of its natural lifetime (bounce/TTL/kill-plane), since only the mirror was destroyed locally on the owner's side — the firer's engine has no idea its bullet was "used up" elsewhere. `HitPatch` stays a local-only UI/FX event exactly as documented; this means the firer doesn't get an immediate visual confirmation that their shot landed on someone else's monster, only the (correctly replicated) monster health/death itself. Acceptable for now — fixing it would mean giving `HitPatch` cross-peer meaning, out of scope here.
- **Still no PvP**: this only extended monster hit-detection to see mirror bullets. A bullet still cannot damage another peer's player — that would need the same treatment applied to players, not assumed by this change.
- If a future consumer ever needs the *firing* peer to know a mirror-detected hit landed, that's a new, separate feature (broadcasting the hit back), not a natural extension of this one.
