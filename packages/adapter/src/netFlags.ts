/**
 * Entity networking profile flags — TS mirror of the `NET_*` constants in
 * `crates/ecs`. Composable dimensions (ownership, type, authority,
 * predictability, urgency), documented once in `specs/engine/README.md`;
 * these numeric values are wire-level and must match the Rust side exactly.
 */
/** Ownership: simulated on this client (physics body, HEALTH semantics). */
export const NET_LOCAL = 0x01;
/** Type: ballistic projectile — the engine integrates its trajectory. */
export const NET_BULLET = 0x02;
/** Type: monster — the engine owns its AI, separation, and hit detection. */
export const NET_MONSTER = 0x04;
/** Authority: this client broadcasts the entity's state to peers. */
export const NET_REPLICATED = 0x08;
/** Predictability: receivers extrapolate from velocity between updates. */
export const NET_PREDICTABLE = 0x10;
/** Urgency: background actor — replicated on a slow stride, not every tick. */
export const NET_LOW_URGENCY = 0x20;
