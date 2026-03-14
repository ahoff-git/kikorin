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
import { disposeRenderer, renderSystem, setupRenderer } from './systems/render'
import { dirtyTransformsSystem } from './systems/dirtyTransforms'
import { commandsSystem, createCoreCommands } from './systems/commands'
import { controlsSystem, createControls, setupControlInputs } from './systems/controls'
import { adjustCameraFollowOrbit, cameraFollowSystem, resetCameraTarget, setCameraFollowTarget, setCameraLookAtTarget } from './systems/cameraFollow'
import { collisionSystem, createCollisionState, setupCollisionSystem } from './systems/collision'
import { gravitySystem } from './systems/gravity'
import type { CoreWorld, Player } from './types'
export type {
    CollisionDirtyFlags,
    ControlEvent,
    ControlEventFilter,
    ControlEventHandler,
    ControlEventInput,
    ControlFilter,
    ControlMatch,
    ControlPhase,
    ControlSourceId,
    ControlState,
    ControlTick,
    ControlTickHandler,
    CoreControls,
    KeyboardControlId,
    CollisionState,
    ColliderShapes,
    CoreCommand,
    CoreCommandHandler,
    CoreCommandInput,
    CoreCommands,
    GravityState,
    CoreWorld,
    CoreWorldBox,
    Player,
    Players,
    Position,
    Positions,
    PointerControlId,
    Rotation,
    Time,
    TouchPairList,
    Vec3,
    Velocities,
    Velocity,
} from './types'
export { ControlSources, KeyboardControls, PointerControls } from './types'
export { configureCuboidCollider, getTouchPairs, getTouchingEntities, markCollisionTransformDirty } from './systems/collision'
export { markTransformDirty, rotateLocalVectorByEntityRotation, setEntityRotation } from './systems/transforms'

function createWorldConfig(maxEntities: number): CoreWorld {
    return {
        components: {
            // They can be any shape you want
            // SoA:
            Position: {
                x: new Float32Array(maxEntities),
                y: new Float32Array(maxEntities),
                z: new Float32Array(maxEntities)
            },
            Velocity: {
                x: new Float32Array(maxEntities),
                y: new Float32Array(maxEntities),
                z: new Float32Array(maxEntities)
            },
            Rotation: {
                yaw: new Float32Array(maxEntities),
                pitch: new Float32Array(maxEntities),
                roll: new Float32Array(maxEntities)
            },
            Collider: {
                Active: new Int8Array(maxEntities),
                Sensor: new Int8Array(maxEntities),
                HalfWidth: new Float32Array(maxEntities),
                HalfHeight: new Float32Array(maxEntities),
                HalfDepth: new Float32Array(maxEntities),
            },
            Gravity: {
                Grounded: new Int8Array(maxEntities),
            },
            Floor: new Int8Array(maxEntities),
            RenderDirtyFlags: {
                DirtyTransformFlag: new Int8Array(maxEntities), //set if Position/Rotation/Scale changes
                DirtyCount: 0, //increment as the list grows
                DirtyList: new Int32Array(maxEntities), //list of eids that have been changed
                DirtyFlagSet: new Int8Array(maxEntities), //set to prevent duplicates in DirtyList
            },
            CollisionDirtyFlags: {
                DirtyTransformFlag: new Int8Array(maxEntities), //set if Position/Rotation/Scale/Collider changes
                ConfigDirtyFlag: new Int8Array(maxEntities), //set if collider configuration changes
                DirtyCount: 0, //increment as the list grows
                DirtyList: new Int32Array(maxEntities), //list of eids that have been changed
                DirtyFlagSet: new Int8Array(maxEntities), //set to prevent duplicates in DirtyList
            },
            Render: new Int32Array(maxEntities),
            Health: new Int32Array(maxEntities),
            // AoS:
            Player: [] as Player[]
        },
        collision: createCollisionState(maxEntities),
        time: {
            delta: 0,
            elapsed: 0,
            then: performance.now(),
            deltaBuffer: createRingBuffer(300),
            avgDelta: 0,
            ticksPerSecond: 0
        },
        commands: createCoreCommands<CoreWorld>(),
        controls: createControls<CoreWorld>(),
        chillUpdater: createChillUpdater(),
    };
}

function setupCoreWorld(canvas: HTMLCanvasElement | null, maxEntities = 100000) {
    let runGameLoop = false;
    let schedulerRegistered = false;
    const world = createWorld<CoreWorld>(createWorldConfig(maxEntities));
    const controlInputs = setupControlInputs(world, canvas);


    function worldTick(world: CoreWorld) {
        timeSystem(world)
        controlsSystem(world)
        commandsSystem(world);
        gravitySystem(world)
        movementSystem(world)
        collisionSystem(world)
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

    function dispose() {
        stop();
        controlInputs.disconnect();
        world.commands.clear();
        world.controls.clear();
        disposeRenderer();
        resetCameraTarget();
    }

    setupRenderer(canvas);
    setupCollisionSystem(world);
    resetCameraTarget();

    // const cube = new Mesh(
    //     new BoxGeometry(1, 1, 1),
    //     new MeshBasicMaterial({ color: 0xff00ff })
    // );

    // addToScene(cube);

    return { world, start, stop, dispose, setCameraFollowTarget, adjustCameraFollowOrbit, setCameraLookAtTarget, resetCameraTarget };

}

export { setupCoreWorld };
