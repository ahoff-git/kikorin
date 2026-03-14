import type { RingBuffer } from '../util/ringBuffer'
import type { Collider as RapierCollider, World as RapierWorld } from '@dimforge/rapier3d-compat'
import type { Object3D } from 'three'
import type { FlaginatorState } from './systems/flaginator'

export type Positions = {
    x: Float32Array,
    y: Float32Array,
    z: Float32Array
}

export type Vec3 = {
    x: number,
    y: number,
    z: number
}

export type Position = {
    x: number,
    y: number,
    z: number
}

export type Velocities = {
    x: Float32Array,
    y: Float32Array,
    z: Float32Array
}

export type Velocity = {
    x: number,
    y: number,
    z: number
}

export type Players = Player[];

export type Player = {
    level: number;
    experience: number;
    name: string;
}

export type CoreColliderConfig = {
    halfWidth: number,
    halfHeight: number,
    halfDepth: number,
    sensor?: boolean,
    active?: boolean
}

export type CoreEntityBlueprint = {
    position?: Partial<Position>,
    velocity?: Partial<Velocity>,
    rotation?: Partial<Rotation>,
    collider?: CoreColliderConfig,
    render?: boolean,
    renderMesh?: Object3D | (() => Object3D),
    gravity?: boolean | {
        grounded?: boolean
    },
    floor?: boolean,
    health?: number,
    player?: Player
}

export type SetupCoreWorldOptions = {
    canvas?: HTMLCanvasElement | null,
    maxEntities?: number,
    autoStart?: boolean,
    worldTickRate?: number
}

export type Time = {
    delta: number,
    elapsed: number,
    then: number,
    deltaBuffer: RingBuffer,
    avgDelta: number,
    ticksPerSecond: number
}

export type RenderDirtyFlags = {
    DirtyTransformFlag: Int8Array, //set if Position/Rotation/Scale changes
    DirtyCount: number, //increment as the list grows
    DirtyList: Int32Array, //list of eids that have been changed 
    DirtyFlagSet: Int8Array, //set to prevent duplicates in DirtyList
}

export type ColliderShapes = {
    Active: Int8Array,
    Sensor: Int8Array,
    HalfWidth: Float32Array,
    HalfHeight: Float32Array,
    HalfDepth: Float32Array
}

export type GravityState = {
    Grounded: Int8Array
}

export type CollisionDirtyFlags = {
    DirtyTransformFlag: Int8Array, //set if Position/Rotation/Scale/Collider changes
    ConfigDirtyFlag: Int8Array, //set if collider configuration changes
    DirtyCount: number, //increment as the list grows
    DirtyList: Int32Array, //list of eids that have been changed
    DirtyFlagSet: Int8Array, //set to prevent duplicates in DirtyList
}

export type TouchPairList = {
    Count: number,
    A: Int32Array,
    B: Int32Array
}

export type CollisionState = {
    ready: boolean,
    initStarted: boolean,
    initError: string | null,
    world: RapierWorld | null,
    collidersByEid: Array<RapierCollider | null>,
    eidByColliderHandle: Map<number, number>,
    touchingByEid: number[][],
    touchPairs: TouchPairList,
    touchPairIndexByKey: Map<number, number>,
    touchPairKeysByIndex: number[],
    scratchTouching: number[],
}

export type Rotations = {
                yaw:  Float32Array,
                pitch: Float32Array,
                roll: Float32Array
}

export type Rotation = {
    yaw: number,
    pitch: number,
    roll: number
}

export type CoreCommand = {
    sequence: number,
    timestamp: number,
    source: string,
    type: string,
    payload?: unknown
}

export type CoreCommandInput = {
    timestamp?: number,
    source: string,
    type: string,
    payload?: unknown
}

export type CoreCommandHandler<TWorld> = (world: TWorld, command: CoreCommand) => void

export type CoreCommands<TWorld> = {
    queue: CoreCommand[],
    handlers: Map<string, CoreCommandHandler<TWorld>[]>,
    enqueue: (command: CoreCommandInput) => number,
    on: (type: string, handler: CoreCommandHandler<TWorld>) => () => void,
    process: (world: TWorld) => void,
    clear: () => void
}

export const ControlSources = {
    Keyboard: "keyboard",
    Pointer: "pointer",
    React: "react",
} as const

export const PointerControls = {
    Primary: "primary",
    Middle: "middle",
    Secondary: "secondary",
} as const

export const KeyboardControls = {
    KeyQ: "KeyQ",
    KeyW: "KeyW",
    KeyE: "KeyE",
    KeyA: "KeyA",
    KeyS: "KeyS",
    KeyD: "KeyD",
    KeyI: "KeyI",
    KeyK: "KeyK",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Space: "Space",
    Enter: "Enter",
    Escape: "Escape",
} as const

export type ControlSourceId = typeof ControlSources[keyof typeof ControlSources]
export type PointerControlId = typeof PointerControls[keyof typeof PointerControls]
export type KeyboardControlId = typeof KeyboardControls[keyof typeof KeyboardControls]

export type ControlPhase = "start" | "change" | "end" | "trigger" | "cancel"

export type ControlEvent = {
    sequence: number,
    timestamp: number,
    source: string,
    controlId: string,
    phase: ControlPhase,
    value: number,
    payload?: unknown
}

export type ControlEventInput = {
    timestamp?: number,
    source: string,
    controlId: string,
    phase: ControlPhase,
    value?: number,
    payload?: unknown
}

export type ControlState = {
    key: string,
    source: string,
    controlId: string,
    active: boolean,
    value: number,
    startedAt: number,
    updatedAt: number,
    durationMs: number,
    totalDurationMs: number,
    activationCount: number,
    triggerCount: number,
    lastTriggeredAt: number,
    phase: ControlPhase,
    payload?: unknown
}

export type ControlMatch<TValue extends string> = TValue | TValue[] | "*"

export type ControlFilter = {
    source?: ControlMatch<string>,
    controlId?: ControlMatch<string>
}

export type ControlEventFilter = ControlFilter & {
    phase?: ControlMatch<ControlPhase>
}

export type ControlEventHandler<TWorld> = (
    world: TWorld,
    event: ControlEvent,
    state: ControlState,
    controls: CoreControls<TWorld>
) => void

export type ControlTickHandler<TWorld> = (
    world: TWorld,
    tick: ControlTick,
    controls: CoreControls<TWorld>
) => void

export type ControlTick = {
    timestamp: number,
    deltaMs: number,
    deltaSeconds: number,
    elapsedMs: number
}

export type CoreControls<TWorld> = {
    queue: ControlEvent[],
    states: Map<string, ControlState>,
    enqueue: (event: ControlEventInput) => number,
    on: (filter: ControlEventFilter, handler: ControlEventHandler<TWorld>) => () => void,
    onTick: (handler: ControlTickHandler<TWorld>) => () => void,
    process: (world: TWorld, tick?: ControlTick) => void,
    getState: (controlId: string, source?: string) => ControlState | undefined,
    getStates: () => ControlState[],
    getActiveStates: () => ControlState[],
    isActive: (controlId: string, source?: string) => boolean,
    isAnyActive: (controlIds: string[], source?: string) => boolean,
    getAxis: (negativeControlIds: string[], positiveControlIds: string[], source?: string) => number,
    cancelActive: (filter?: ControlFilter, timestamp?: number) => void,
    clear: () => void
}

export type CoreWorld = {
    components: {
        Position: Positions,
        Velocity: Velocities,
        Rotation: Rotations,
        Collider: ColliderShapes,
        Gravity: GravityState,
        Floor: Int8Array,
        Health: Int32Array,
        Render: Int32Array,
        Player: Players,
        RenderDirtyFlags: RenderDirtyFlags,
        CollisionDirtyFlags: CollisionDirtyFlags
    },    
    collision: CollisionState,
    time: Time,
    commands: CoreCommands<CoreWorld>,
    controls: CoreControls<CoreWorld>,
    chillUpdater: ReturnType<typeof import('../util/chillUpdate').createChillUpdater>,
    flaginator: FlaginatorState<CoreWorld, string>
}

export type CoreComponentName = keyof CoreWorld["components"]

export type CoreWorldBox = {
    world: CoreWorld
    start: () => void
    stop: () => void
    dispose: () => void
    isRunning: () => boolean
    spawnEntity: (definition: CoreEntityBlueprint) => number
    destroyEntity: (eid: number) => void
    queryEntities: (componentNames: readonly CoreComponentName[]) => number[]
    hasEntityComponents: (eid: number, componentNames: readonly CoreComponentName[]) => boolean
    setEntityPosition: (eid: number, position: Partial<Position>) => boolean
    setEntityVelocity: (eid: number, velocity: Partial<Velocity>) => boolean
    setCameraFollowTarget: (eid: number, opts?: { offset?: Partial<Position> }) => void
    adjustCameraFollowOrbit: (deltaYaw: number, deltaPitch: number) => void
    setCameraLookAtTarget: (eid: number, opts?: { position?: Partial<Position> }) => void
    setEntityRotation: (eid: number, rotation: Partial<Rotation>) => boolean
    resetCameraTarget: () => void
}
