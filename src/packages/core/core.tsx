import {
    createWorld,
} from 'bitecs'
import { createRingBuffer } from '../util/ringBuffer'
import { createChillUpdater } from '../util/chillUpdate'
import { movementSystem } from './systems/movement'
import { experienceSystem } from './systems/experience'
import { timeSystem } from './systems/time'
import { uiBridgeSystem } from './systems/uiBridge'
import { healthSystem } from './systems/health'
import { renderSystem, setupRenderer } from './systems/render'
import type { CoreWorld, Player } from './types'
export type { CoreWorldBox, Positions, Position, Velocities, Velocity, Players, Player, Time, CoreWorld } from './types'

function setupCoreWorld(canvas: HTMLCanvasElement | null, MAX_ENTITIES = 100000) {

    let runGameLoop = false;
    const world: CoreWorld = createWorld({
        components: {
            // They can be any shape you want
            // SoA:
            Position: {
                x: new Int32Array(MAX_ENTITIES),
                y: new Int32Array(MAX_ENTITIES),
                z: new Int32Array(MAX_ENTITIES)
            },
            Velocity: {
                x: new Float32Array(1e5),
                y: new Float32Array(1e5),
                z: new Float32Array(1e5)
            },
            Health: new Int32Array,
            // AoS:
            Player: [] as Player[]
        },
        time: {
            delta: 0,
            elapsed: 0,
            then: performance.now(),
            deltaBuffer: createRingBuffer(300),
            avgDelta: 0,
            ticksPerSecond: 0
        },
        chillUpdater: createChillUpdater<any>(),
    }) as CoreWorld;


    const update = (world: CoreWorld) => {
        timeSystem(world)
        movementSystem(world)
        experienceSystem(world)
        healthSystem(world)
        uiBridgeSystem(world)
        renderSystem(world)
    }

    function start() {
        runGameLoop = true;
        requestAnimationFrame(function gameLoop() {
            update(world);
            if (runGameLoop) {
                requestAnimationFrame(gameLoop);
            }
        })
    }

    function stop() {
        runGameLoop = false;
    }

    setupRenderer(canvas);

    return { world, start, stop };

}

export { setupCoreWorld };
