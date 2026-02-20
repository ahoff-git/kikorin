import {
    createWorld,
} from 'bitecs'
import { createRingBuffer } from '../util/ringBuffer'
import { createChillUpdater } from '../util/chillUpdate'
import { Crono } from '../util/chronoTrigger'
import { movementSystem } from './systems/movement'
import { experienceSystem } from './systems/experience'
import { timeSystem } from './systems/time'
import { uiBridgeSystem } from './systems/uiBridge'
import { healthSystem } from './systems/health'
import { renderSystem, setupRenderer } from './systems/render'
import { dirtyTransformsSystem } from './systems/dirtyTransforms'
import { commandsSystem, createCoreCommands } from './systems/commands'
import { cameraFollowSystem, resetCameraTarget, setCameraFollowTarget, setCameraLookAtTarget } from './systems/cameraFollow'
import type { CoreWorld, Player } from './types'
export type { CoreWorldBox, Positions, Position, Velocities, Velocity, Players, Player, Time, CoreWorld, CoreCommand, CoreCommandInput, CoreCommandHandler, CoreCommands } from './types'

function setupCoreWorld(canvas: HTMLCanvasElement | null, MAX_ENTITIES = 100000) {
    let runGameLoop = false;
    let schedulerRegistered = false;

    const worldConfig: CoreWorld = {
        components: {
            // They can be any shape you want
            // SoA:
            Position: {
                x: new Float32Array(MAX_ENTITIES),
                y: new Float32Array(MAX_ENTITIES),
                z: new Float32Array(MAX_ENTITIES)
            },
            Velocity: {
                x: new Float32Array(MAX_ENTITIES),
                y: new Float32Array(MAX_ENTITIES),
                z: new Float32Array(MAX_ENTITIES)
            },
            Rotation: {
                yaw: new Float32Array(MAX_ENTITIES),
                pitch: new Float32Array(MAX_ENTITIES),
                roll: new Float32Array(MAX_ENTITIES)
            },
            RenderDirtyFlags: {
                DirtyTransformFlag: new Int8Array(MAX_ENTITIES), //set if Position/Rotation/Scale changes
                DirtyCount: 0, //increment as the list grows
                DirtyList: new Int32Array(MAX_ENTITIES), //list of eids that have been changed 
                DirtyFlagSet: new Int8Array(MAX_ENTITIES), //set to prevent duplicates in DirtyList
            },
            Render: new Int32Array(MAX_ENTITIES),
            Health: new Int32Array(MAX_ENTITIES),
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
        commands: createCoreCommands<CoreWorld>(),
        chillUpdater: createChillUpdater<any>(),
    };
    const world = createWorld<CoreWorld>(worldConfig);


    function worldTick(world: CoreWorld) {
        commandsSystem(world);
        timeSystem(world)
        movementSystem(world)
        experienceSystem(world)
        healthSystem(world)
        if (world.components.RenderDirtyFlags.DirtyCount > 0) {
            dirtyTransformsSystem(world)
        }
        uiBridgeSystem(world)
    }

    function renderTick(world: CoreWorld){
        cameraFollowSystem(world);
        renderSystem(world);
    }

    function start() {
        if (runGameLoop) return;
        runGameLoop = true;

        if (!schedulerRegistered) {
            Crono.runAt({
                name: "worldTick",
                fpsTarget: 60,
                callback: () => {
                    if (!runGameLoop) return;
                    worldTick(world);
                }
            });
            Crono.runAt({
                name: "renderSystem",
                callback: () => {
                    if (!runGameLoop) return;
                    renderTick(world);
                }
            });
            schedulerRegistered = true;
        }
        Crono.Start();
    }

    function stop() {
        runGameLoop = false;
        Crono.Stop();
    }

    setupRenderer(canvas);
    resetCameraTarget();

    // const cube = new Mesh(
    //     new BoxGeometry(1, 1, 1),
    //     new MeshBasicMaterial({ color: 0xff00ff })
    // );

    // addToScene(cube);

    return { world, start, stop, setCameraFollowTarget, setCameraLookAtTarget, resetCameraTarget };

}

export { setupCoreWorld };
