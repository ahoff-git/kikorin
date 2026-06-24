import type { CoreWorld } from './types'

// Bitmask flags stored in NetFlags[eid] (Int8Array, indexed by entity id).
// Flags compose freely — use the named helpers to set common combinations.
export const NET = {
  // This peer simulates this entity locally (owns authoritative state).
  OWNED: 0b00000001,
  // Owned entity: broadcast state to network peers each tick.
  SHARED: 0b00000010,
  // Remote entity: also run local movement prediction; network updates can overwrite.
  PREDICT: 0b00000100,
  // Entity is a bullet type: use bullet mesh on remote, signal life/death via flag.
  PROJECTILE: 0b00001000,
} as const

// --- Low-level access ---

export function getNetFlags(world: CoreWorld, eid: number): number {
  return world.components.NetFlags[eid]!
}

export function setNetFlags(world: CoreWorld, eid: number, flags: number): void {
  world.components.NetFlags[eid] = flags
}

export function addNetFlag(world: CoreWorld, eid: number, flag: number): void {
  world.components.NetFlags[eid] |= flag
}

export function removeNetFlag(world: CoreWorld, eid: number, flag: number): void {
  world.components.NetFlags[eid] &= ~flag
}

export function hasNetFlag(world: CoreWorld, eid: number, flag: number): boolean {
  return (world.components.NetFlags[eid]! & flag) !== 0
}

// --- Ownership configuration helpers ---
// Each sets the ownership bits while preserving the entity-type bits (PROJECTILE).

// Owned by this peer, state sent to network peers each tick.
export function makeOwnedShared(world: CoreWorld, eid: number): void {
  const typeBits = world.components.NetFlags[eid]! & NET.PROJECTILE
  world.components.NetFlags[eid] = typeBits | NET.OWNED | NET.SHARED
}

// Owned by this peer, not sent to network (pure local entity).
export function makeOwnedPrivate(world: CoreWorld, eid: number): void {
  const typeBits = world.components.NetFlags[eid]! & NET.PROJECTILE
  world.components.NetFlags[eid] = typeBits | NET.OWNED
}

// Remote entity: run local movement prediction; incoming network updates overwrite.
// Requires a Velocity component so the movement system processes this entity.
export function makeRemotePredicted(world: CoreWorld, eid: number): void {
  const typeBits = world.components.NetFlags[eid]! & NET.PROJECTILE
  world.components.NetFlags[eid] = typeBits | NET.PREDICT
}

// Remote entity: only use positions received from network, no local simulation.
export function makeRemoteNetworkOnly(world: CoreWorld, eid: number): void {
  const typeBits = world.components.NetFlags[eid]! & NET.PROJECTILE
  world.components.NetFlags[eid] = typeBits
}

// Mark entity as the projectile type (bullet mesh, life/death signaling).
// Compose with an ownership helper: makeOwnedShared + makeProjectileType = owned bullet.
export function makeProjectileType(world: CoreWorld, eid: number): void {
  world.components.NetFlags[eid] |= NET.PROJECTILE
}

// --- Per-tick decision helpers ---

// Should the movement system simulate this entity locally?
// Projectile-type entities are moved by game-specific code, not the movement system.
// Remote entities without PREDICT have no Velocity and are excluded by the system query.
export function shouldSimulateLocally(world: CoreWorld, eid: number): boolean {
  return (world.components.NetFlags[eid]! & NET.PROJECTILE) === 0
}

// Should this entity's state be sent over the network this tick?
export function shouldSendState(world: CoreWorld, eid: number): boolean {
  const flags = world.components.NetFlags[eid]!
  return (flags & (NET.OWNED | NET.SHARED)) === (NET.OWNED | NET.SHARED)
}

// Should incoming network positions overwrite this entity's state?
// True for all remote entities (OWNED is not set).
export function shouldAcceptNetworkUpdate(world: CoreWorld, eid: number): boolean {
  return (world.components.NetFlags[eid]! & NET.OWNED) === 0
}

// Is this entity a projectile (bullet) type?
export function isProjectileType(world: CoreWorld, eid: number): boolean {
  return (world.components.NetFlags[eid]! & NET.PROJECTILE) !== 0
}
