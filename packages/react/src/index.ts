export { KikorinCanvas } from './KikorinCanvas'
export type { KikorinCanvasProps } from './KikorinCanvas'

export { useKikorin } from './useKikorin'
export type { UseKikorinOptions } from './useKikorin'

export { useKikorinEvent } from './useKikorinEvent'

export { spawnFloor, spawnPlayer, spawnRigidBody, spawnTrigger } from './spawn'
export type {
  SpawnFloorOptions,
  SpawnPlayerOptions,
  SpawnRigidBodyOptions,
  SpawnTriggerOptions,
} from './spawn'

// Re-export key engine types and constants so consumers only need one import
export type {
  CoreColliderConfig,
  CoreEntityBlueprint,
  CoreWorldBox,
  Player,
  Position,
  Rotation,
  Time,
  Velocity,
  ControlState,
} from '@kikorin/engine'
export { ControlSources, KeyboardControls, PointerControls } from '@kikorin/engine'

export type { EventBusEvents } from '@kikorin/events'
