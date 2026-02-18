import { rng } from "@/packages/util/random";
import { setupCoreWorld, CoreWorld, CoreWorldBox, Position, Velocity, Player } from "../packages/core/core";
import { addComponent, addEntity} from "bitecs";
import { BoxGeometry, Mesh, MeshBasicMaterial } from "three";
import { setObjectTransformByEid, upsertObjectByEid } from "../packages/core/systems/render";

const PERSON_GEOMETRY = new BoxGeometry(1, 1, 1);
const PERSON_MATERIAL = new MeshBasicMaterial({ color: 0x66ccff });

function createPersonRenderMesh() {
    return new Mesh(PERSON_GEOMETRY, PERSON_MATERIAL);
}

export type World = { UniqueTestThing: "Testing123" } & CoreWorld;
export type WorldBox = CoreWorldBox & {world:World};
function setupWorld(canvas: HTMLCanvasElement | null) {
    console.log("DOING SETUP")
    const worldBox = setupCoreWorld(canvas) as WorldBox;
    const prime = createPerson(worldBox.world, { x: 0, y: 0, z: 0 }, { x: 0.01, y: 0, z: 0 }, 100, { level: 0, experience: 0, name: `DoomPrime` });
    worldBox.setCameraFollowTarget(prime);
    for (let i = 0; i < 1000; i++) {
        createPerson(worldBox.world, { x: 0, y: 0, z: 0 }, { x: rng(0, .01, 2), y: rng(0, .01, 2), z: rng(0, .01, 2) }, 100, { level: 0, experience: 0, name: `Doom${i}` });
    }
    
    return worldBox;
}

function createPerson(world: World, position: Position, velocity: Velocity, health: number, player: Player) {
    const { Position, Velocity, Rotation, Player, Health, Render } = world.components

    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Velocity)
    addComponent(world, eid, Rotation)
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
