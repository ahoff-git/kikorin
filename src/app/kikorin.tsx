import { rng } from "@/packages/util/random";
import { configureCuboidCollider, setupCoreWorld, CoreWorld, CoreWorldBox, Position, Velocity, Player } from "../packages/core/core";
import { addComponent, addEntity} from "bitecs";
import { BoxGeometry, Mesh, MeshBasicMaterial } from "three";
import { setObjectTransformByEid, upsertObjectByEid } from "../packages/core/systems/render";

const PERSON_GEOMETRY = new BoxGeometry(1, 1, 1);
const PERSON_BASE_MATERIAL = new MeshBasicMaterial({ color: 0x66ccff });
const PERSON_TOUCH_MATERIAL = new MeshBasicMaterial({ color: 0xff6b3d });

function createPersonRenderMesh() {
    const mesh = new Mesh(PERSON_GEOMETRY, PERSON_BASE_MATERIAL);
    mesh.userData.baseMaterial = PERSON_BASE_MATERIAL;
    mesh.userData.touchMaterial = PERSON_TOUCH_MATERIAL;
    return mesh;
}

export type World = { UniqueTestThing: "Testing123" } & CoreWorld;
export type WorldBox = CoreWorldBox & {world:World};
function setupWorld(canvas: HTMLCanvasElement | null) {
    console.log("DOING SETUP")
    const worldBox = setupCoreWorld(canvas) as WorldBox;
    const prime = createPerson(worldBox.world, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0}, 100, { level: 0, experience: 0, name: `DoomPrime` });
    worldBox.setCameraFollowTarget(prime);
    const numBlocks = 10000;
    for (let i = 0; i < numBlocks; i++) {
        const range = Math.sqrt(numBlocks) * 2;
        const moving = rng(0, 10) > 9; // 10% chance to be moving
        const rvx = moving ? rng(-10, 10, 2) : 0;
        const rvy = moving ? rng(-10, 10, 2) : 0;
        const rvz = moving ? rng(-10, 10, 2) : 0;
        const rx = rng(-range, range);
        const ry = rng(-range, range);
        const rz = rng(-range, range);
        createPerson(worldBox.world, { x: rx, y: ry, z: rz }, { x: rvx, y: rvy, z: rvz }, 100, { level: 0, experience: 0, name: `Doom${i}` });
    }
    
    return worldBox;
}

function createPerson(world: World, position: Position, velocity: Velocity, health: number, player: Player) {
    const { Position, Velocity, Rotation, Player, Health, Render, Collider } = world.components

    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Velocity)
    addComponent(world, eid, Rotation)
    addComponent(world, eid, Collider)
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

export { setupWorld };
