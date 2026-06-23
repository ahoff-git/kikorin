import type {
  CoreColliderConfig,
  CoreEntityBlueprint,
  CoreWorldBox,
  Player,
  Position,
  Velocity,
} from '@kikorin/engine'

type Mesh = CoreEntityBlueprint['renderMesh']

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export interface SpawnPlayerOptions {
  position?: Partial<Position>
  name?: string
  level?: number
  health?: number
  mesh?: Mesh
}

/** Spawn a player entity with gravity, a standing collider, and face-velocity rotation. */
export function spawnPlayer(engine: CoreWorldBox, opts: SpawnPlayerOptions = {}): number {
  const player: Player = {
    level: opts.level ?? 1,
    experience: 0,
    name: opts.name ?? 'Player',
  }
  return engine.spawnEntity({
    position: opts.position,
    gravity: true,
    collider: { halfWidth: 0.5, halfHeight: 0.9, halfDepth: 0.5 },
    health: opts.health ?? 100,
    player,
    renderMesh: opts.mesh,
    faceVelocity: true,
  })
}

// ---------------------------------------------------------------------------
// Floor
// ---------------------------------------------------------------------------

export interface SpawnFloorOptions {
  position?: Partial<Position>
  halfWidth?: number
  halfHeight?: number
  halfDepth?: number
  mesh?: Mesh
}

/** Spawn a static floor plane. Defaults to a 50×1×50 slab centred at y = -0.5. */
export function spawnFloor(engine: CoreWorldBox, opts: SpawnFloorOptions = {}): number {
  return engine.spawnEntity({
    position: opts.position ?? { x: 0, y: -0.5, z: 0 },
    floor: true,
    collider: {
      halfWidth: opts.halfWidth ?? 25,
      halfHeight: opts.halfHeight ?? 0.5,
      halfDepth: opts.halfDepth ?? 25,
    },
    renderMesh: opts.mesh,
  })
}

// ---------------------------------------------------------------------------
// Rigid body
// ---------------------------------------------------------------------------

export interface SpawnRigidBodyOptions {
  position?: Partial<Position>
  velocity?: Partial<Velocity>
  gravity?: boolean
  health?: number
  collider?: CoreColliderConfig
  mesh?: Mesh
}

/** Spawn a generic physics body. Collider defaults to a unit cube. */
export function spawnRigidBody(engine: CoreWorldBox, opts: SpawnRigidBodyOptions = {}): number {
  return engine.spawnEntity({
    position: opts.position,
    velocity: opts.velocity,
    gravity: opts.gravity,
    health: opts.health,
    collider: opts.collider ?? { halfWidth: 0.5, halfHeight: 0.5, halfDepth: 0.5 },
    renderMesh: opts.mesh,
  })
}

// ---------------------------------------------------------------------------
// Trigger / sensor
// ---------------------------------------------------------------------------

export interface SpawnTriggerOptions {
  position?: Partial<Position>
  halfWidth?: number
  halfHeight?: number
  halfDepth?: number
}

/** Spawn a sensor collider that detects overlaps without exerting physics forces. */
export function spawnTrigger(engine: CoreWorldBox, opts: SpawnTriggerOptions = {}): number {
  return engine.spawnEntity({
    position: opts.position,
    collider: {
      halfWidth: opts.halfWidth ?? 1,
      halfHeight: opts.halfHeight ?? 1,
      halfDepth: opts.halfDepth ?? 1,
      sensor: true,
    },
  })
}
