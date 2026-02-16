import { rng } from "@/packages/util/random";
import { setupCoreWorld, CoreWorld, CoreWorldBox, Position, Velocity, Player } from "../packages/core/core";
import { addComponent, addEntity} from "bitecs";

export type World = { UniqueTestThing: "Testing123" } & CoreWorld;
export type WorldBox = CoreWorldBox & {world:World};
function setupWorld(canvas: HTMLCanvasElement | null) {
    console.log("DOING SETUP")
    const worldBox = setupCoreWorld(canvas) as WorldBox;
    for (let i = 0; i < 1000; i++) {
        createPerson(worldBox.world, { x: rng(0, 500), y: rng(0, 500), z: rng(0, 500) }, { x: rng(0, 5), y: rng(0, 5), z: rng(0, 5) }, 100, { level: 0, experience: 0, name: `Doom${i}` });
    }
    return worldBox;
}

function createPerson(world: World, position: Position, velocity: Velocity, health: number, player: Player) {
    const { Position, Velocity, Player, Health } = world.components

    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Velocity)
    addComponent(world, eid, Player)
    addComponent(world, eid, Health)

    // SoA access pattern
    Position.x[eid] = position.x;
    Position.y[eid] = position.y;
    Position.z[eid] = position.z;
    Velocity.x[eid] = velocity.x;
    Velocity.y[eid] = velocity.y;
    Velocity.z[eid] = velocity.z;
    Health[eid] = health;

    // AoS access pattern  
    Player[eid] = player;
}

export { setupWorld };
