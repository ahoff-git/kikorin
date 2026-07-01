// TODO: These helpers previously spawned entities via the TypeScript ECS engine (@kikorin/engine).
// That package was removed. Implement spawning through the Rust WASM engine (crates/engine).

export interface SpawnPlayerOptions {
  position?: { x?: number; y?: number; z?: number }
  name?: string
  level?: number
  health?: number
}

export interface SpawnFloorOptions {
  position?: { x?: number; y?: number; z?: number }
  halfWidth?: number
  halfHeight?: number
  halfDepth?: number
}

export interface SpawnRigidBodyOptions {
  position?: { x?: number; y?: number; z?: number }
  velocity?: { x?: number; y?: number; z?: number }
  gravity?: boolean
  health?: number
}

export interface SpawnTriggerOptions {
  position?: { x?: number; y?: number; z?: number }
  halfWidth?: number
  halfHeight?: number
  halfDepth?: number
}

export function spawnPlayer(_engine: unknown, _opts: SpawnPlayerOptions = {}): number { return 0 }
export function spawnFloor(_engine: unknown, _opts: SpawnFloorOptions = {}): number { return 0 }
export function spawnRigidBody(_engine: unknown, _opts: SpawnRigidBodyOptions = {}): number { return 0 }
export function spawnTrigger(_engine: unknown, _opts: SpawnTriggerOptions = {}): number { return 0 }
