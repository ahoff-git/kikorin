import type { RingBuffer } from '../util/ringBuffer'

export type Positions = {
    x: Int32Array,
    y: Int32Array,
    z: Int32Array
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

export type CoreWorld = {
    components: {
        Position: Positions,
        Velocity: Velocities,
        Health: Int32Array,
        Player: Players,
        RenderDirtyFlags: RenderDirtyFlags
    },    
    time: Time,
    chillUpdater: ReturnType<typeof import('../util/chillUpdate').createChillUpdater<any>>
}

export type CoreWorldBox = {
    world: CoreWorld
    start: () => void
    stop: () => void
}
