import type { RingBuffer } from '../util/ringBuffer'
import type { Collider as RapierCollider, World as RapierWorld } from '@dimforge/rapier3d-compat'

export type Positions = {
    x: Float32Array,
    y: Float32Array,
    z: Float32Array
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

export type CoreWorld = {
    components: {
        Position: Positions,
        Velocity: Velocities,
        Rotation: Rotations,
        Collider: ColliderShapes,
        Health: Int32Array,
        Render: Int32Array,
        Player: Players,
        RenderDirtyFlags: RenderDirtyFlags,
        CollisionDirtyFlags: CollisionDirtyFlags
    },    
    collision: CollisionState,
    time: Time,
    commands: CoreCommands<CoreWorld>,
    chillUpdater: ReturnType<typeof import('../util/chillUpdate').createChillUpdater<any>>
}

export type CoreWorldBox = {
    world: CoreWorld
    start: () => void
    stop: () => void
    setCameraFollowTarget: (eid: number, opts?: { offset?: Partial<Position> }) => void
    setCameraLookAtTarget: (eid: number, opts?: { position?: Partial<Position> }) => void
    resetCameraTarget: () => void
}
