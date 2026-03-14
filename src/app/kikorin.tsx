import { clamp, rng } from "@/packages/util/random";
import { PlayerReactControls } from "./kikorinControls";
import {
    configureCuboidCollider,
    ControlSources,
    KeyboardControls,
    PointerControls,
    rotateLocalVectorByEntityRotation,
    setEntityRotation,
    setupCoreWorld,
    CoreWorld,
    CoreWorldBox,
    Position,
    Velocity,
    Player
} from "../packages/core/core";
import { addComponent, addEntity} from "bitecs";
import {
    BoxGeometry,
    EdgesGeometry,
    LineBasicMaterial,
    LineSegments,
    Mesh,
    MeshBasicMaterial,
} from "three";
import { setObjectTransformByEid, upsertObjectByEid } from "../packages/core/systems/render";

const PERSON_GEOMETRY = new BoxGeometry(1, 1, 1);
const PERSON_EDGE_GEOMETRY = new EdgesGeometry(PERSON_GEOMETRY);
const PERSON_BASE_MATERIAL = new MeshBasicMaterial({ color: 0x66ccff });
const PERSON_TOUCH_MATERIAL = new MeshBasicMaterial({ color: 0xff6b3d });
const PERSON_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x16324f });
const FLOOR_HALF_WIDTH = 240;
const FLOOR_HALF_HEIGHT = 1;
const FLOOR_HALF_DEPTH = 240;
const FLOOR_TOP_Y = 0;
const FLOOR_GEOMETRY = new BoxGeometry(
    FLOOR_HALF_WIDTH * 2,
    FLOOR_HALF_HEIGHT * 2,
    FLOOR_HALF_DEPTH * 2,
);
const FLOOR_EDGE_GEOMETRY = new EdgesGeometry(FLOOR_GEOMETRY);
const FLOOR_BASE_MATERIAL = new MeshBasicMaterial({ color: 0x445342 });
const FLOOR_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x243022 });
const PLAYER_ACCELERATION = 30;
const PLAYER_MAX_SPEED = 18;
const PLAYER_DRAG_PER_SECOND = 4;
const PLAYER_JUMP_SPEED = 8;
const PLAYER_FORWARD_BOOST = 10;
const PLAYER_FORWARD_KEYS = [KeyboardControls.KeyW, KeyboardControls.ArrowUp];
const PLAYER_BACKWARD_KEYS = [KeyboardControls.KeyS, KeyboardControls.ArrowDown];
const PLAYER_STRAFE_LEFT_KEYS = [KeyboardControls.KeyQ];
const PLAYER_STRAFE_RIGHT_KEYS = [KeyboardControls.KeyE];
const PLAYER_LOOK_LEFT_KEYS = [KeyboardControls.KeyA, KeyboardControls.ArrowLeft];
const PLAYER_LOOK_RIGHT_KEYS = [KeyboardControls.KeyD, KeyboardControls.ArrowRight];
const PLAYER_PITCH_UP_KEYS = [KeyboardControls.KeyI];
const PLAYER_PITCH_DOWN_KEYS = [KeyboardControls.KeyK];
const PLAYER_PITCH_SPEED = 1.5;
const PLAYER_YAW_SPEED = 1.5;
const PLAYER_MAX_PITCH = Math.PI * 0.45;

function createPersonRenderMesh() {
    const mesh = new Mesh(PERSON_GEOMETRY, PERSON_BASE_MATERIAL);
    const outline = new LineSegments(PERSON_EDGE_GEOMETRY, PERSON_EDGE_MATERIAL);
    outline.renderOrder = 1;
    outline.scale.setScalar(1.001);
    mesh.userData.baseMaterial = PERSON_BASE_MATERIAL;
    mesh.userData.touchMaterial = PERSON_TOUCH_MATERIAL;
    mesh.add(outline);
    return mesh;
}

function createFloorRenderMesh() {
    const mesh = new Mesh(FLOOR_GEOMETRY, FLOOR_BASE_MATERIAL);
    const outline = new LineSegments(FLOOR_EDGE_GEOMETRY, FLOOR_EDGE_MATERIAL);
    outline.renderOrder = 1;
    outline.scale.setScalar(1.0005);
    mesh.add(outline);
    return mesh;
}

export type World = { UniqueTestThing: "Testing123" } & CoreWorld;
export type WorldBox = CoreWorldBox & {world:World};
function setupWorld(canvas: HTMLCanvasElement | null) {
    console.log("DOING SETUP")
    const worldBox = setupCoreWorld(canvas) as WorldBox;
    createFloor(worldBox.world, { x: 0, y: FLOOR_TOP_Y - FLOOR_HALF_HEIGHT, z: 0 });
    const prime = createPerson(worldBox.world, { x: 0, y: 12, z: 0 }, { x: 0, y: 0, z: 0}, 100, { level: 0, experience: 0, name: `DoomPrime` });
    registerPrimeControls(worldBox.world, prime);
    worldBox.setCameraFollowTarget(prime);
    const numBlocks = 10000;
    const spawnRangeX = FLOOR_HALF_WIDTH - 4;
    const spawnRangeZ = FLOOR_HALF_DEPTH - 4;
    for (let i = 0; i < numBlocks; i++) {
        const moving = rng(0, 10) > 9; // 10% chance to be moving
        const rvx = moving ? rng(-10, 10, 2) : 0;
        const rvz = moving ? rng(-10, 10, 2) : 0;
        const rx = rng(-spawnRangeX, spawnRangeX);
        const ry = rng(FLOOR_TOP_Y + 4, FLOOR_TOP_Y + 60);
        const rz = rng(-spawnRangeZ, spawnRangeZ);
        createPerson(worldBox.world, { x: rx, y: ry, z: rz }, { x: rvx, y: 0, z: rvz }, 100, { level: 0, experience: 0, name: `Doom${i}` });
    }
    
    return worldBox;
}

function registerPrimeControls(world: CoreWorld, eid: number) {
    const jump = (activeWorld: CoreWorld) => {
        const { Gravity, Velocity } = activeWorld.components;
        if (Gravity.Grounded[eid] === 0) return;
        Velocity.y[eid] = clamp(PLAYER_JUMP_SPEED, -PLAYER_MAX_SPEED, PLAYER_MAX_SPEED);
        Gravity.Grounded[eid] = 0;
    };

    world.controls.onTick((activeWorld, tick, controls) => {
        const dt = tick.deltaSeconds;
        if (dt === 0) return;

        const drag = Math.max(0, 1 - PLAYER_DRAG_PER_SECOND * dt);
        const { Velocity, Rotation } = activeWorld.components;
        const velocity = Velocity;
        velocity.x[eid] *= drag;
        velocity.z[eid] *= drag;

        const moveX = controls.getAxis(PLAYER_STRAFE_LEFT_KEYS, PLAYER_STRAFE_RIGHT_KEYS, ControlSources.Keyboard);
        const moveZ = controls.getAxis(PLAYER_FORWARD_KEYS, PLAYER_BACKWARD_KEYS, ControlSources.Keyboard);
        const pitchAxis = controls.getAxis(PLAYER_PITCH_DOWN_KEYS, PLAYER_PITCH_UP_KEYS, ControlSources.Keyboard);
        const yawAxis = controls.getAxis(PLAYER_LOOK_RIGHT_KEYS, PLAYER_LOOK_LEFT_KEYS, ControlSources.Keyboard);
        const localAcceleration = {
            x: moveX * PLAYER_ACCELERATION,
            y: 0,
            z: moveZ * PLAYER_ACCELERATION,
        };
        const worldAcceleration = rotateLocalVectorByEntityRotation(activeWorld, eid, localAcceleration);

        velocity.x[eid] = clamp(velocity.x[eid] + worldAcceleration.x * dt, -PLAYER_MAX_SPEED, PLAYER_MAX_SPEED);
        velocity.y[eid] = clamp(velocity.y[eid] + worldAcceleration.y * dt, -PLAYER_MAX_SPEED, PLAYER_MAX_SPEED);
        velocity.z[eid] = clamp(velocity.z[eid] + worldAcceleration.z * dt, -PLAYER_MAX_SPEED, PLAYER_MAX_SPEED);

        if (pitchAxis !== 0 || yawAxis !== 0) {
            const nextRotation: Parameters<typeof setEntityRotation>[2] = {};
            if (pitchAxis !== 0) {
                nextRotation.pitch = clamp(
                    Rotation.pitch[eid] + pitchAxis * PLAYER_PITCH_SPEED * dt,
                    -PLAYER_MAX_PITCH,
                    PLAYER_MAX_PITCH,
                );
            }
            if (yawAxis !== 0) {
                nextRotation.yaw = Rotation.yaw[eid] + yawAxis * PLAYER_YAW_SPEED * dt;
            }
            setEntityRotation(activeWorld, eid, nextRotation);
        }
    });

    world.controls.on({ source: ControlSources.Pointer, controlId: PointerControls.Primary, phase: "trigger" }, (activeWorld) => {
        jump(activeWorld);
    });

    world.controls.on({ source: ControlSources.Keyboard, controlId: KeyboardControls.Space, phase: "start" }, (activeWorld) => {
        jump(activeWorld);
    });

    world.controls.on({ source: ControlSources.React, controlId: PlayerReactControls.BoostForward, phase: "trigger" }, (activeWorld) => {
        const velocity = activeWorld.components.Velocity;
        velocity.z[eid] = clamp(velocity.z[eid] - PLAYER_FORWARD_BOOST, -PLAYER_MAX_SPEED, PLAYER_MAX_SPEED);
    });
}

function createPerson(world: World, position: Position, velocity: Velocity, health: number, player: Player) {
    const { Position, Velocity, Rotation, Player, Health, Render, Collider, Gravity } = world.components

    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Velocity)
    addComponent(world, eid, Rotation)
    addComponent(world, eid, Collider)
    addComponent(world, eid, Gravity)
    addComponent(world, eid, Player)
    addComponent(world, eid, Health)
    addComponent(world, eid, Render)

    // SoA access pattern
    Position.x[eid] = position.x;
    Position.y[eid] = position.y;
    Position.z[eid] = position.z;
    Velocity.x[eid] = velocity.x;
    Velocity.y[eid] = velocity.y;
    Velocity.z[eid] = velocity.z;
    Rotation.yaw[eid] = 0;
    Rotation.pitch[eid] = 0;
    Rotation.roll[eid] = 0;
    Gravity.Grounded[eid] = 0;
    Render[eid] = 1;
    Health[eid] = health;
    configureCuboidCollider(world, eid, {
        halfWidth: 0.5,
        halfHeight: 0.5,
        halfDepth: 0.5,
    })

    // AoS access pattern  
    Player[eid] = player;

    upsertObjectByEid(eid, createPersonRenderMesh);
    setObjectTransformByEid(
        eid,
        Position.x[eid],
        Position.y[eid],
        Position.z[eid],
        Rotation.pitch[eid],
        Rotation.yaw[eid],
        Rotation.roll[eid]
    );
    return eid;
}

function createFloor(world: World, position: Position) {
    const { Position, Rotation, Render, Collider, Floor } = world.components

    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Rotation)
    addComponent(world, eid, Collider)
    addComponent(world, eid, Render)
    addComponent(world, eid, Floor)

    Position.x[eid] = position.x;
    Position.y[eid] = position.y;
    Position.z[eid] = position.z;
    Rotation.yaw[eid] = 0;
    Rotation.pitch[eid] = 0;
    Rotation.roll[eid] = 0;
    Floor[eid] = 1;
    Render[eid] = 1;

    configureCuboidCollider(world, eid, {
        halfWidth: FLOOR_HALF_WIDTH,
        halfHeight: FLOOR_HALF_HEIGHT,
        halfDepth: FLOOR_HALF_DEPTH,
    })

    upsertObjectByEid(eid, createFloorRenderMesh);
    setObjectTransformByEid(
        eid,
        Position.x[eid],
        Position.y[eid],
        Position.z[eid],
        Rotation.pitch[eid],
        Rotation.yaw[eid],
        Rotation.roll[eid]
    );

    return eid;
}

export { setupWorld };
